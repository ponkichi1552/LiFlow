import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { analysisRetryAt } from '../../features/appliance-care/analysis-work';
import type { AnalysisTarget, SharedAnalysisBasis } from '../../features/appliance-care/analysis-work';
import type { ApplianceCareApiRequest } from '../../features/appliance-care/api-contracts';
import { analyzeApplianceCareRequest, applianceCareApiBaseUrl } from '../../features/appliance-care/api-client';
import { deviceAnalysisDeliveries } from '../storage/analysis-deliveries';
import { deviceAnalysisWork } from '../storage/analysis-work';
import { readApplianceManual } from '../storage/appliance-manuals';
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

export async function startAnalysisWork(database: SQLiteDatabase, input: {
  owner: string; target: AnalysisTarget; request: ApplianceCareApiRequest; filename?: string; basis?: SharedAnalysisBasis;
}) {
  if (await currentAnalysisOwner() !== input.owner) throw new Error('解析を開始するアカウントを確認してください。');
  await deviceAnalysisWork(database).begin({ ...input, id: randomUUID(), baseUrl: applianceCareApiBaseUrl() });
}

/** All entry points join the same local run. A status check does not create a second admission. */
export async function resumeAnalysisWork(database: SQLiteDatabase, owner: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) return false;
  const baseUrl = applianceCareApiBaseUrl();
  const store = deviceAnalysisWork(database);
  const entry = await store.next(owner, baseUrl);
  if (!entry || await currentAnalysisOwner() !== owner || options.signal?.aborted) return false;
  if (entry.retryAt > Date.now()) return { retryAt: entry.retryAt };
  const key = JSON.stringify([owner, entry.id]);
  const existing = running.get(key);
  const operation = existing ?? (async () => {
    if (Date.now() - entry.createdAt >= RESULT_RECOVERY_MS) {
      await store.finish(owner, entry.id, { status: 'error', code: 'JOB_NOT_FOUND', message: '解析結果の受け取り期限が過ぎました。PDFを解析し直してください。' });
      return;
    }
    const base64 = await readApplianceManual(database, entry.manualDigest).catch(() => null);
    if (options.signal?.aborted) return;
    if (!base64) {
      await store.finish(owner, entry.id, { status: 'error', code: 'INVALID_MANUAL', message: '説明書PDFを読み込めませんでした。選び直してください。' });
      return;
    }
    if (!await store.markAttempt(owner, entry.id) || options.signal?.aborted) return;
    const result = await analyzeApplianceCareRequest({ ...entry.request, manual: { base64, rightsConfirmed: true } }, baseUrl,
      options.timeoutMs, undefined, options.signal, deviceAnalysisDeliveries(database),
      { owner, id: entry.id, manualDigest: entry.manualDigest, resuming: entry.attempts > 0 });
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
