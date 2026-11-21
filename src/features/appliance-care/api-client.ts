import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { matchesUploadedManual } from './manual-source';
import { Platform } from 'react-native';
import { isOfficialApplianceUrl } from '@/features/appliance-care/official-url';
import { applianceCarePollDelay, waitForAppliancePoll } from './polling';
import { isAnalysisRecord as isRecord, nonemptyAnalysisString as nonemptyString, isVerifiedApplianceAnalysis } from './analysis-validation';
import { ANALYSIS_TIMEOUT_MS, analysisDeliveryJson, validAnalysisDelivery } from '../../../server/appliance-care-api/src/analysis-delivery-contract.mjs';
import { MANUAL_UPLOAD_CONTENT_TYPE } from '../../../server/appliance-care-api/src/manual-upload-contract.mjs';
import type { AnalysisDeliveryStore, SavedAnalysisDelivery } from './analysis-delivery';
import type { ApplianceApiSession } from '../../platform/appliance-care/auth';

import type {
  ApplianceCareAnalysisStage,
  ApplianceCareApiRequest,
  ApplianceCareApiResponse,
} from '@/features/appliance-care/api-contracts';

// Retain only unfinished transport attempts. A retry after a lost acknowledgement reuses the same paid admission.
const pendingAdmissions = new Map<string, { id: string; expiresAt: number }>();

async function analysisCacheKeys(baseUrl: string, request: ApplianceCareApiRequest) {
  const text = JSON.stringify([baseUrl, request]);
  const forceSuffix = ',"forceReanalysis":true}]';
  const ordinary = request.forceReanalysis && text.endsWith(forceSuffix) ? `${text.slice(0, -forceSuffix.length)}}]` : text;
  const hash = async (value: string) => {
    if (value.length < 128 * 1024) return bytesToHex(sha256(utf8ToBytes(value)));
    // Avoid a PDF-sized temporary UTF-8 array and a long synchronous hash on Hermes.
    const crypto = await import('expo-crypto');
    return crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, value);
  };
  const retryKey = await hash(text);
  return { retryKey, cacheKey: ordinary === text ? retryKey : await hash(ordinary) };
}

export function applianceCareApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
}

export async function analyzeApplianceCareRequest(
  request: ApplianceCareApiRequest,
  baseUrl = applianceCareApiBaseUrl(),
  timeoutMs = ANALYSIS_TIMEOUT_MS,
  onStage?: (stage: ApplianceCareAnalysisStage) => void,
  signal?: AbortSignal,
  deliveries?: AnalysisDeliveryStore,
  work?: { owner: string; id: string; manualDigest: string; resuming: boolean; recoveryOnly?: boolean },
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
  if ((request.identifyFromManual === true && !request.manual) || (!noIdentity && fields.some(field => {
    const value = request[field];
    if (field === 'modelNumber' && request.identifyFromManual === true && value == null) return false;
    return typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(value);
  }))) {
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
  let admissionId: string | undefined;
  try {
    const { retryKey, cacheKey } = await abortApplianceWait(() => analysisCacheKeys(baseUrl, normalized), controller.signal);
    const session = await abortApplianceWait(async () => {
      const { authorizeApplianceCareApi } = await import('../../platform/appliance-care/auth');
      return authorizeApplianceCareApi(baseUrl);
    }, controller.signal);
    if (work && session.userId !== work.owner) return temporaryError('解析を開始したアカウントで再開してください。');
    const attemptKey = JSON.stringify([session.userId, retryKey]);
    const finishAttempt = () => { if (pendingAdmissions.get(attemptKey)?.id === admissionId) pendingAdmissions.delete(attemptKey); };
    if (deliveries && session.userId) {
      // Receipts carry no PDF/result. Retry them only when there is real local pending work.
      void flushAnalysisReceipts(deliveries, session, baseUrl).catch(() => undefined);
      if (!normalized.forceReanalysis) {
        const cached = await deliveries.read(session.userId, cacheKey);
        if (cached?.status === 'verified' && isApiResponse(cached)
          && (!work || cached.analysis.manualSource?.sha256 === work.manualDigest)) { finishAttempt(); return cached; }
      }
    }
    for (const [key, item] of pendingAdmissions) if (item.expiresAt <= Date.now()) pendingAdmissions.delete(key);
    const previous = pendingAdmissions.get(attemptKey);
    const proposedId = work?.id ?? previous?.id ?? (await abortApplianceWait(() => session.headers(), controller.signal))['x-idempotency-key'];
    admissionId = previous?.id ?? proposedId;
    let jobId: string | undefined;
    if (deliveries && session.userId && admissionId) {
      const saved = await deliveries.admission(session.userId, retryKey, admissionId);
      admissionId = saved.id;
      if (isJobAccepted(saved)) jobId = saved.jobId;
    }
    if (admissionId) {
      if (previous?.id !== admissionId) {
        pendingAdmissions.set(attemptKey, { id: admissionId, expiresAt: Date.now() + 24 * 60 * 60_000 });
        while (pendingAdmissions.size > 32) pendingAdmissions.delete(pendingAdmissions.keys().next().value!);
      }
    }
    const jobHeaders = async () => {
      const headers = await session.headers({ deviceProof: true, admissionId });
      if (admissionId) headers['x-idempotency-key'] = admissionId;
      return headers;
    };
    if (!jobId) {
      const endpoint = `${baseUrl}/api/appliance-care/jobs`;
      const resumeUpload = normalized.manual && admissionId && (work?.resuming || previous || admissionId !== proposedId);
      const receiptResponse = resumeUpload ? await abortApplianceWait(async () => {
        const headers = await jobHeaders();
        controller.signal.throwIfAborted();
        return fetch(`${endpoint}/admission`, { method: 'GET', redirect: 'error', headers, signal: controller.signal });
      }, controller.signal) : undefined;
      let startResponse = receiptResponse;
      let startPayload = receiptResponse ? await abortApplianceWait(() => readJson(receiptResponse), controller.signal) : undefined;
      // Only the authenticated admission endpoint can confirm that this PDF still needs to be uploaded.
      if (!startResponse || (startResponse.status === 404 && isRecord(startPayload) && startPayload.code === 'ADMISSION_NOT_FOUND')) {
        if (work?.recoveryOnly) {
          if (deliveries && session.userId && admissionId) await deliveries.completeAdmission(session.userId, retryKey, admissionId);
          finishAttempt();
          return { status: 'error', code: 'JOB_NOT_FOUND', message: '解析結果の受け取り期限が過ぎました。PDFを解析し直してください。' };
        }
        const uploadResponse = await abortApplianceWait(async () => {
          const options = { method: 'POST', redirect: 'error' as const, signal: controller.signal };
          const uploadHeaders = await jobHeaders();
          if (normalized.manual) {
            const { encryptManualUpload } = await import('./manual-upload-crypto');
            const body = await encryptManualUpload({ ...normalized, manual: normalized.manual }, session.userId, admissionId ?? '');
            const native = await import('expo/fetch');
            controller.signal.throwIfAborted();
            return native.fetch(endpoint, { ...options, headers: { ...uploadHeaders, 'content-type': MANUAL_UPLOAD_CONTENT_TYPE }, body });
          }
          controller.signal.throwIfAborted();
          return fetch(endpoint, { ...options, headers: { ...uploadHeaders, 'content-type': 'application/json' }, body: JSON.stringify(normalized) });
        }, controller.signal);
        startResponse = uploadResponse;
        startPayload = await abortApplianceWait(() => readJson(uploadResponse), controller.signal);
      }
      controller.signal.throwIfAborted();
      if (isApiResponse(startPayload)) {
        // An expired admission is retired only once the server reports it. The next attempt requires another explicit action.
        if (startPayload.status === 'error' && startPayload.code === 'REQUEST_CONFLICT' && deliveries && session.userId && admissionId) {
          await deliveries.completeAdmission(session.userId, retryKey, admissionId);
        }
        if (startPayload.status === 'error' && startPayload.code === 'REQUEST_CONFLICT'
          || startResponse !== receiptResponse && startResponse && startResponse.status < 500 && startResponse.status !== 429) finishAttempt();
        return startPayload;
      }
      if (!startResponse?.ok || !isJobAccepted(startPayload)) {
        return temporaryError('家電解析APIに接続できません。APIサーバーの状態を確認してください。');
      }
      jobId = startPayload.jobId;
      if (deliveries && session.userId && admissionId) {
        await deliveries.recordJob(session.userId, retryKey, admissionId, jobId);
      }
    }

    const statusUrl = `${baseUrl}/api/appliance-care/jobs/${encodeURIComponent(jobId)}`;
    let lastStage: ApplianceCareAnalysisStage | undefined;
    let pollAttempt = 0;
    while (!controller.signal.aborted) {
      const headers = await abortApplianceWait(jobHeaders, controller.signal);
      if (controller.signal.aborted) return temporaryError('解析の通信を中断しました。');
      const statusResponse = await abortApplianceWait(() => fetch(statusUrl, {
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
        if (work && output.status === 'verified' && output.analysis.manualSource?.sha256 !== work.manualDigest) {
          return temporaryError('解析結果と選んだPDFが一致しません。');
        }
        if (statusPayload.delivery !== undefined) {
          if (!validAnalysisDelivery(statusPayload.delivery)
            || bytesToHex(sha256(utf8ToBytes(analysisDeliveryJson(statusPayload.result)))) !== statusPayload.delivery.digest) {
            return temporaryError('解析結果の受信を確認できませんでした。再試行してください。');
          }
          if (deliveries && session.userId) {
            controller.signal.throwIfAborted();
            await deliveries.save(session.userId, cacheKey, { jobId, baseUrl, receipt: statusPayload.delivery }, output, request.manual,
              work ? { workId: work.id, manualDigest: work.manualDigest, requestKey: retryKey, admissionId } : undefined);
            // Deletion starts after the SQLite transaction. UI need not wait for its network round-trip.
            void flushAnalysisReceipts(deliveries, session, baseUrl)
              .then(() => flushAnalysisReceipts(deliveries, session, baseUrl)).catch(() => undefined);
            if (!work && admissionId) await deliveries.completeAdmission(session.userId, retryKey, admissionId);
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
    if (!controller.signal.aborted && cause instanceof Error && 'code' in cause && (cause.code === 'AUTHENTICATION_REQUIRED'
      || cause.code === 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE' || cause.code === 'INVALID_MANUAL' || cause.code === 'INVALID_REQUEST'
      || cause.code === 'DEVICE_VERIFICATION_REQUIRED' || cause.code === 'DEVICE_VERIFICATION_UNAVAILABLE' || cause.code === 'DEVICE_VERIFICATION_TEMPORARY'
      || cause.code === 'REINSTALL_ACCOUNT_LOCKED' || cause.code === 'ACCESS_DENIED' || cause.code === 'SUBSCRIPTION_REQUIRED'
      || cause.code === 'TEMPORARY_NETWORK_ERROR')) {
      return { status: 'error', code: cause.code, message: cause.message, ...('retryAt' in cause && typeof cause.retryAt === 'string' ? { retryAt: cause.retryAt } : {}) };
    }
    return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : controller.signal.aborted
      ? '解析がタイムアウトしました。時間をおいて再試行してください。'
      : '家電解析APIに接続できません。APIサーバーと接続先URLを確認してください。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

type ReceiptRun = { work?: Promise<void>; failures: number; retryAt: number };
const receiptWorkers = new WeakMap<AnalysisDeliveryStore, Map<string, ReceiptRun>>();
export function analysisReceiptRetryAt(store: AnalysisDeliveryStore, userId: string, baseUrl: string): number {
  return receiptWorkers.get(store)?.get(JSON.stringify([userId, baseUrl]))?.retryAt ?? 0;
}
export function flushAnalysisReceipts(store: AnalysisDeliveryStore, session: ApplianceApiSession, baseUrl: string, background = false): Promise<void> {
  let scopes = receiptWorkers.get(store); if (!scopes) { scopes = new Map(); receiptWorkers.set(store, scopes); }
  const key = JSON.stringify([session.userId, baseUrl]); let state = scopes.get(key);
  if (!state) { state = { failures: 0, retryAt: 0 }; scopes.set(key, state); }
  if (state.work) return background ? Promise.resolve() : state.work;
  const captured = state;
  const work = (async () => {
    try {
      for (const delivery of await store.pending(session.userId, baseUrl)) {
        if (delivery.baseUrl !== baseUrl || !validAnalysisDelivery(delivery.receipt)) continue;
        if (delivery.receipt.expiresAt <= Date.now()) { await store.acknowledged(session.userId, delivery.jobId); continue; }
        await sendAnalysisReceipt(delivery, session);
        await store.acknowledged(session.userId, delivery.jobId);
        if (background) break;
      }
      captured.failures = 0; captured.retryAt = 0;
    } catch (error) { captured.retryAt = Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(captured.failures++, 4)); throw error; }
  })();
  captured.work = work;
  void work.finally(() => { if (captured.work === work) captured.work = undefined; }).catch(() => undefined);
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
  if (!nonemptyString(product.manufacturer) || !nonemptyString(product.productName)
    || !(nonemptyString(product.modelNumber) && analysis.model !== null || product.modelNumber === null && analysis.model === null && matchesUploadedManual(officialSources.manualUrl, analysis))
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
