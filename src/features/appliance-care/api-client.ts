import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { matchesUploadedManual } from './manual-source';
import { Platform } from 'react-native';
import { isOfficialApplianceUrl } from '@/features/appliance-care/official-url';
import { applianceCarePollDelay, waitForAppliancePoll } from './polling';
import { isAnalysisRecord as isRecord, nonemptyAnalysisString as nonemptyString, isVerifiedApplianceAnalysis } from './analysis-validation';
import { analysisDeliveryJson, validAnalysisDelivery } from '../../../server/appliance-care-api/src/analysis-delivery-contract.mjs';
import type { AnalysisDeliveryStore, SavedAnalysisDelivery } from './analysis-delivery';
import type { ApplianceApiSession } from '../../platform/appliance-care/auth';

import type {
  ApplianceCareAnalysisStage,
  ApplianceCareApiRequest,
  ApplianceCareApiResponse,
} from '@/features/appliance-care/api-contracts';

const DEFAULT_TIMEOUT_MS = 120_000;
// Retain only unfinished transport attempts. A retry after a lost acknowledgement reuses the same paid admission.
const pendingAdmissions = new Map<string, { id: string; expiresAt: number }>();

export function applianceCareApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
}

export async function analyzeApplianceCareRequest(
  request: ApplianceCareApiRequest,
  baseUrl = applianceCareApiBaseUrl(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onStage?: (stage: ApplianceCareAnalysisStage) => void,
  signal?: AbortSignal,
  deliveries?: AnalysisDeliveryStore,
): Promise<ApplianceCareApiResponse> {
  if (signal?.aborted) return temporaryError('解析の通信を中断しました。');
  const normalized = {
    ...(request.identifyFromManual === true ? { identifyFromManual: true as const } : {}),
    ...Object.fromEntries(['manufacturer', 'productName', 'modelNumber'].filter(field => typeof request[field as keyof ApplianceCareApiRequest] === 'string')
      .map(field => [field, (request[field as keyof ApplianceCareApiRequest] as string).trim()])),
    ...(request.category?.trim() ? { category: request.category.trim() } : {}),
    ...(request.manual ? { manual: request.manual } : {}),
    ...(request.forceReanalysis ? { forceReanalysis: true } : {}),
  };
  const fields = ['manufacturer', 'productName', 'modelNumber'] as const;
  const noIdentity = request.identifyFromManual === true && fields.every(field => request[field] === undefined);
  if ((request.identifyFromManual === true && !request.manual) || (!noIdentity && fields.some(field => typeof request[field] !== 'string'
    || !request[field]!.trim() || request[field]!.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(request[field]!)))) {
    return {
      status: 'error',
      code: 'INVALID_REQUEST',
      message: request.identifyFromManual ? '取扱説明書PDFを選んでください。' : 'メーカー名・製品名・型番を入力してください（各120文字以内）。',
    };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const retryKey = bytesToHex(sha256(utf8ToBytes(JSON.stringify([baseUrl, normalized]))));
  const cacheKey = bytesToHex(sha256(utf8ToBytes(JSON.stringify([baseUrl, { ...normalized, forceReanalysis: undefined }]))));
  let admissionId: string | undefined;
  const finishAttempt = () => { if (pendingAdmissions.get(retryKey)?.id === admissionId) pendingAdmissions.delete(retryKey); };
  try {
    const session = await abortApplianceWait(async () => {
      const { authorizeApplianceCareApi } = await import('../../platform/appliance-care/auth');
      return authorizeApplianceCareApi(baseUrl);
    }, controller.signal);
    if (deliveries && session.userId) {
      // Receipts carry no PDF/result. Retry them only when there is real local pending work.
      void flushAnalysisReceipts(deliveries, session, baseUrl).catch(() => undefined);
      if (!normalized.forceReanalysis) {
        const cached = await deliveries.read(session.userId, cacheKey);
        if (cached?.status === 'verified' && isApiResponse(cached)) { finishAttempt(); return cached; }
      }
    }
    const startHeaders = await abortApplianceWait(() => session.headers(), controller.signal);
    if (controller.signal.aborted) return temporaryError('解析の通信を中断しました。');
    for (const [key, item] of pendingAdmissions) if (item.expiresAt <= Date.now()) pendingAdmissions.delete(key);
    const previous = pendingAdmissions.get(retryKey);
    if (previous) startHeaders['x-idempotency-key'] = previous.id;
    else if (startHeaders['x-idempotency-key']) {
      pendingAdmissions.set(retryKey, { id: startHeaders['x-idempotency-key'], expiresAt: Date.now() + 24 * 60 * 60_000 });
      while (pendingAdmissions.size > 32) pendingAdmissions.delete(pendingAdmissions.keys().next().value!);
    }
    admissionId = startHeaders['x-idempotency-key'];
    if (deliveries && session.userId && admissionId) {
      admissionId = await deliveries.admission(session.userId, retryKey, admissionId);
      startHeaders['x-idempotency-key'] = admissionId;
    }
    const startResponse = await abortApplianceWait(() => fetch(`${baseUrl}/api/appliance-care/jobs`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...startHeaders },
      body: JSON.stringify(normalized),
      signal: controller.signal,
    }), controller.signal);
    const startPayload: unknown = await abortApplianceWait(() => readJson(startResponse), controller.signal);
    if (controller.signal.aborted) return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : '解析がタイムアウトしました。時間をおいて再試行してください。');
    if (isApiResponse(startPayload)) {
      // Retire an expired admission only after the server's terminal verdict.
      // A fresh paid attempt still requires the user's next explicit action.
      if (startPayload.status === 'error' && startPayload.code === 'REQUEST_CONFLICT' && deliveries && session.userId && admissionId) {
        await deliveries.completeAdmission(session.userId, retryKey, admissionId);
      }
      finishAttempt(); return startPayload;
    }
    if (!startResponse.ok || !isJobAccepted(startPayload)) {
      return temporaryError('家電解析APIに接続できません。APIサーバーの状態を確認してください。');
    }

    let lastStage: ApplianceCareAnalysisStage | undefined;
    let pollAttempt = 0;
    while (!controller.signal.aborted) {
      const headers = await abortApplianceWait(() => session.headers(), controller.signal);
      if (controller.signal.aborted) return temporaryError('解析の通信を中断しました。');
      const statusResponse = await abortApplianceWait(() => fetch(`${baseUrl}/api/appliance-care/jobs/${encodeURIComponent(startPayload.jobId)}`, {
        method: 'GET',
        redirect: 'error',
        headers,
        signal: controller.signal,
      }), controller.signal);
      const statusPayload: unknown = await abortApplianceWait(() => readJson(statusResponse), controller.signal);
      if (controller.signal.aborted) return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : '解析がタイムアウトしました。時間をおいて再試行してください。');
      if (isApiResponse(statusPayload)) {
        if (statusPayload.status === 'error' && statusPayload.code === 'JOB_NOT_FOUND') {
          if (deliveries && session.userId && admissionId) await deliveries.completeAdmission(session.userId, retryKey, admissionId);
          finishAttempt();
        }
        return statusPayload;
      }
      if (!statusResponse.ok || !isJobStatus(statusPayload)) {
        return temporaryError('解析状況を確認できません。通信状態を確認して再試行してください。');
      }
      if (statusPayload.stage !== lastStage) {
        pollAttempt = 0;
        lastStage = statusPayload.stage;
        onStage?.(lastStage);
      }
      if (statusPayload.done) {
        if (!isApiResponse(statusPayload.result)) return temporaryError('解析結果を読み取れませんでした。時間をおいて再試行してください。');
        const output = { ...statusPayload.result, ...(isApplianceCareUsage(statusPayload.usage) ? { usage: statusPayload.usage } : {}) };
        if (statusPayload.delivery !== undefined) {
          if (!validAnalysisDelivery(statusPayload.delivery)
            || bytesToHex(sha256(utf8ToBytes(analysisDeliveryJson(statusPayload.result)))) !== statusPayload.delivery.digest) {
            return temporaryError('解析結果の受信を確認できませんでした。再試行してください。');
          }
          if (deliveries && session.userId) {
            controller.signal.throwIfAborted();
            await deliveries.save(session.userId, cacheKey, { jobId: startPayload.jobId, baseUrl, receipt: statusPayload.delivery }, output, request.manual);
            // Deletion starts after the SQLite transaction. UI need not wait for its network round-trip.
            void flushAnalysisReceipts(deliveries, session, baseUrl)
              .then(() => flushAnalysisReceipts(deliveries, session, baseUrl)).catch(() => undefined);
            if (admissionId) await deliveries.completeAdmission(session.userId, retryKey, admissionId);
          }
        }
        else if (deliveries && session.userId && admissionId) {
          // Older servers retain their own result; completing that legacy attempt must still permit an explicit reanalysis.
          await deliveries.completeAdmission(session.userId, retryKey, admissionId);
        }
        finishAttempt();
        return output;
      }
      await waitForAppliancePoll(applianceCarePollDelay(pollAttempt++, statusPayload.pollAfterMs), controller.signal);
    }
    return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : '解析がタイムアウトしました。時間をおいて再試行してください。');
  } catch (cause) {
    if (!controller.signal.aborted && cause instanceof Error && 'code' in cause && cause.code === 'AUTHENTICATION_REQUIRED') {
      return { status: 'error', code: 'AUTHENTICATION_REQUIRED', message: cause.message };
    }
    return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : controller.signal.aborted
      ? '解析がタイムアウトしました。時間をおいて再試行してください。'
      : '家電解析APIに接続できません。APIサーバーと接続先URLを確認してください。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const receiptWorkers = new WeakMap<AnalysisDeliveryStore, Promise<void>>();
export function flushAnalysisReceipts(store: AnalysisDeliveryStore, session: ApplianceApiSession, baseUrl: string): Promise<void> {
  const running = receiptWorkers.get(store); if (running) return running;
  const work = (async () => {
    for (const delivery of await store.pending(session.userId)) {
      if (delivery.baseUrl !== baseUrl || !validAnalysisDelivery(delivery.receipt)) continue;
      if (delivery.receipt.expiresAt <= Date.now()) { await store.acknowledged(session.userId, delivery.jobId); continue; }
      await sendAnalysisReceipt(delivery, session);
      await store.acknowledged(session.userId, delivery.jobId);
    }
  })();
  receiptWorkers.set(store, work);
  void work.finally(() => { if (receiptWorkers.get(store) === work) receiptWorkers.delete(store); }).catch(() => undefined);
  return work;
}
async function sendAnalysisReceipt(delivery: SavedAnalysisDelivery, session: ApplianceApiSession): Promise<void> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = await abortApplianceWait(() => session.headers(), controller.signal);
    const response = await abortApplianceWait(() => fetch(`${delivery.baseUrl}/api/appliance-care/jobs/${encodeURIComponent(delivery.jobId)}/receipt`, {
      method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(delivery.receipt), signal: controller.signal,
    }), controller.signal);
    const body = await abortApplianceWait(() => response.json(), controller.signal);
    if (!response.ok || !isRecord(body) || body.acknowledged !== true) throw new Error('Analysis receipt not accepted');
  } finally { clearTimeout(timer); }
}

function temporaryError(message: string): ApplianceCareApiResponse {
  return { status: 'error', code: 'TEMPORARY_NETWORK_ERROR', message };
}

export function abortApplianceWait<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Appliance request aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isApiResponse(value: unknown): value is ApplianceCareApiResponse {
  if (!isRecord(value)) return false;
  if (value.usage !== undefined && !isApplianceCareUsage(value.usage)) return false;
  const status = value.status;
  if (status === 'not_found') return nonemptyString(value.message);
  if (status === 'error') return nonemptyString(value.code) && nonemptyString(value.message);
  if (status === 'ambiguous') return Array.isArray(value.candidates) && value.candidates.length > 0
    && value.candidates.every((candidate) => isRecord(candidate)
      && nonemptyString(candidate.manufacturer) && nonemptyString(candidate.productName)
      && (candidate.modelNumber === undefined || nonemptyString(candidate.modelNumber))
      && nonemptyString(candidate.officialProductUrl)
      && isOfficialApplianceUrl(candidate.officialProductUrl, candidate.manufacturer));
  if (status !== 'verified' || !isRecord(value.product) || !isRecord(value.officialSources) || !isRecord(value.analysis)) return false;
  const { product, officialSources, analysis } = value;
  if (!nonemptyString(product.manufacturer) || !nonemptyString(product.productName) || !nonemptyString(product.modelNumber)
    || (product.category !== undefined && typeof product.category !== 'string')
    || !nonemptyString(officialSources.manualUrl) || !(isOfficialApplianceUrl(officialSources.manualUrl, product.manufacturer) || matchesUploadedManual(officialSources.manualUrl, analysis))
    || (officialSources.productUrl !== undefined && (typeof officialSources.productUrl !== 'string'
      || !isOfficialApplianceUrl(officialSources.productUrl, product.manufacturer)))) return false;
  return isVerifiedApplianceAnalysis(analysis, product.manufacturer);
}

function isJobAccepted(value: unknown): value is { jobId: string } {
  return Boolean(value && typeof value === 'object' && 'jobId' in value && typeof value.jobId === 'string'
    && /^[a-zA-Z0-9-]{1,128}$/u.test(value.jobId));
}

function isJobStatus(value: unknown): value is {
  stage: ApplianceCareAnalysisStage;
  done: boolean;
  result?: unknown;
  pollAfterMs?: unknown;
  usage?: unknown;
  delivery?: unknown;
} {
  if (!value || typeof value !== 'object' || !('stage' in value) || !('done' in value)) return false;
  return (value.stage === 'product_verification' || value.stage === 'official_manual_analysis')
    && typeof value.done === 'boolean';
}

export function isApplianceCareUsage(value: unknown): value is import('./api-contracts').ApplianceCareUsage {
  return isRecord(value) && Number.isSafeInteger(value.limit) && Number(value.limit) > 0
    && Number.isSafeInteger(value.used) && Number(value.used) >= 0 && Number.isSafeInteger(value.remaining)
    && value.remaining === Math.max(0, Number(value.limit) - Number(value.used))
    && typeof value.resetsAt === 'string' && Number.isFinite(Date.parse(value.resetsAt));
}
