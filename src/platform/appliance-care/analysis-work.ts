import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { analysisRetryAt } from '../../features/appliance-care/analysis-work';
import type { AnalysisTarget, AnalysisWorkBasis } from '../../features/appliance-care/analysis-work';
import type { ApplianceCareApiRequest } from '../../features/appliance-care/api-contracts';
import { analyzeApplianceCareRequest, applianceCareApiBaseUrl } from '../../features/appliance-care/api-client';
import { deviceAnalysisDeliveries } from '../storage/analysis-deliveries';
import { deviceAnalysisWork } from '../storage/analysis-work';
import { InvalidStoredManualError, readApplianceManual } from '../storage/appliance-manuals';
import { getSharingServices, isSharingConfigured } from '../sharing/firebase-services';

const RESULT_RECOVERY_MS = 24 * 60 * 60_000;
const running = new Map<string, Promise<void>>();
export function canResumeAnalysisWork() {
  return Boolean(process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim()) && isSharingConfigured();
}

export async function currentAnalysisOwner() {
  if (!canResumeAnalysisWork()) return null;
  const { auth } = getSharingServices();
  await auth.authStateReady();
  return auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : null;
}

export async function hasNativeAnalysisBackgroundWork(database: SQLiteDatabase, owner: string, mayAnalyze: boolean) {
  const baseUrl = applianceCareApiBaseUrl();
  return mayAnalyze && await deviceAnalysisWork(database).hasPending(owner)
    || baseUrl.startsWith('https://') && await deviceAnalysisDeliveries(database).hasPending(owner, baseUrl);
}

export async function startAnalysisWork(database: SQLiteDatabase, input: {
  owner: string; target: AnalysisTarget; request: ApplianceCareApiRequest; filename?: string; basis?: AnalysisWorkBasis;
}) {
  if (await currentAnalysisOwner() !== input.owner) throw new Error('解析を開始するアカウントを確認してください。');
  return deviceAnalysisWork(database).begin({ ...input, id: randomUUID(), baseUrl: applianceCareApiBaseUrl() });
}

/** All entry points join the same local run. A status check does not create a second admission. */
export async function resumeAnalysisWork(database: SQLiteDatabase, owner: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (options.signal?.aborted || await currentAnalysisOwner() !== owner || options.signal?.aborted) return false;
  const baseUrl = applianceCareApiBaseUrl();
  const store = deviceAnalysisWork(database);
  const entry = await store.next(owner, baseUrl);
  if (!entry || options.signal?.aborted) return false;
  if (entry.retryAt > Date.now()) return { retryAt: entry.retryAt };
  const key = JSON.stringify([owner, entry.id]);
  const existing = running.get(key);
  // A headless pass must leave the pending work registered without waiting on
  // a foreground request that can outlive the headless connection's budget.
  if (existing && options.timeoutMs !== undefined) return true;
  const operation = existing ?? (async () => {
    // Older installations stored only the queue timestamp. Keep their previous recovery boundary.
    const recoveryOnly = entry.attempts > 0 && Date.now() - (entry.firstAttemptAt ?? entry.createdAt) >= RESULT_RECOVERY_MS;
    let base64: string | null;
    try { base64 = await readApplianceManual(database, entry.manualDigest); }
    catch (error) {
      if (!(error instanceof InvalidStoredManualError)) throw error;
      base64 = null;
    }
    if (options.signal?.aborted) return;
    if (!base64) {
      await store.finish(owner, entry.id, { status: 'error', code: 'INVALID_MANUAL', message: '説明書PDFを読み込めませんでした。選び直してください。' });
      return;
    }
    if (!await store.markAttempt(owner, entry.id) || options.signal?.aborted) return;
    const result = await analyzeApplianceCareRequest({ ...entry.request, manual: { base64, rightsConfirmed: true } }, baseUrl,
      options.timeoutMs, undefined, options.signal, deviceAnalysisDeliveries(database),
      { owner, id: entry.id, manualDigest: entry.manualDigest, resuming: entry.attempts > 0, ...(recoveryOnly ? { recoveryOnly } : {}) });
    if (options.signal?.aborted) return;
    const retryAt = analysisRetryAt(result, entry.attempts, Date.now());
    if (retryAt === null) await store.finish(owner, entry.id, result);
    else await store.retry(owner, entry.id, retryAt);
  })();
  if (!existing) running.set(key, operation);
  try { await operation; }
  finally { if (running.get(key) === operation) running.delete(key); }
  const pending = await store.next(owner, baseUrl);
  return pending ? { retryAt: pending.retryAt } : false;
}
