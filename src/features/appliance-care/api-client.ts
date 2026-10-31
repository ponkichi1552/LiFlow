import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { matchesUploadedManual } from './manual-source';
import { Platform } from 'react-native';
import { isOfficialApplianceUrl } from '@/features/appliance-care/official-url';
import { applianceCarePollDelay, waitForAppliancePoll } from './polling';
import { isAnalysisRecord as isRecord, nonemptyAnalysisString as nonemptyString, isVerifiedApplianceAnalysis } from './analysis-validation';

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
): Promise<ApplianceCareApiResponse> {
  if (signal?.aborted) return temporaryError('解析の通信を中断しました。');
  const normalized = {
    manufacturer: request.manufacturer.trim(),
    productName: request.productName.trim(),
    modelNumber: request.modelNumber.trim(),
    ...(request.category?.trim() ? { category: request.category.trim() } : {}),
    ...(request.manual ? { manual: request.manual } : {}),
    ...(request.forceReanalysis ? { forceReanalysis: true } : {}),
  };
  if ([normalized.manufacturer, normalized.productName, normalized.modelNumber]
    .some((value) => value.length === 0 || value.length > 120)) {
    return {
      status: 'error',
      code: 'INVALID_REQUEST',
      message: 'メーカー名・製品名・型番を入力してください（各120文字以内）。',
    };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const retryKey = bytesToHex(sha256(utf8ToBytes(JSON.stringify([baseUrl, normalized]))));
  let admissionId: string | undefined;
  const finishAttempt = () => { if (pendingAdmissions.get(retryKey)?.id === admissionId) pendingAdmissions.delete(retryKey); };
  try {
    const session = await abortApplianceWait(async () => {
      const { authorizeApplianceCareApi } = await import('../../platform/appliance-care/auth');
      return authorizeApplianceCareApi(baseUrl);
    }, controller.signal);
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
    const startResponse = await fetch(`${baseUrl}/api/appliance-care/jobs`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...startHeaders },
      body: JSON.stringify(normalized),
      signal: controller.signal,
    });
    const startPayload: unknown = await readJson(startResponse);
    if (controller.signal.aborted) return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : '解析がタイムアウトしました。時間をおいて再試行してください。');
    if (isApiResponse(startPayload)) { finishAttempt(); return startPayload; }
    if (!startResponse.ok || !isJobAccepted(startPayload)) {
      return temporaryError('家電解析APIに接続できません。APIサーバーの状態を確認してください。');
    }

    let lastStage: ApplianceCareAnalysisStage | undefined;
    let pollAttempt = 0;
    while (!controller.signal.aborted) {
      const headers = await abortApplianceWait(() => session.headers(), controller.signal);
      if (controller.signal.aborted) return temporaryError('解析の通信を中断しました。');
      const statusResponse = await fetch(`${baseUrl}/api/appliance-care/jobs/${encodeURIComponent(startPayload.jobId)}`, {
        method: 'GET',
        redirect: 'error',
        headers,
        signal: controller.signal,
      });
      const statusPayload: unknown = await readJson(statusResponse);
      if (controller.signal.aborted) return temporaryError(signal?.aborted ? '解析の通信を中断しました。' : '解析がタイムアウトしました。時間をおいて再試行してください。');
      if (isApiResponse(statusPayload)) {
        if (statusPayload.status === 'error' && statusPayload.code === 'JOB_NOT_FOUND') finishAttempt();
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
        finishAttempt();
        return isApiResponse(statusPayload.result)
          ? { ...statusPayload.result, ...(isApplianceCareUsage(statusPayload.usage) ? { usage: statusPayload.usage } : {}) }
          : temporaryError('解析結果を読み取れませんでした。もう一度検索してください。');
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
