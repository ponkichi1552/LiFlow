import { GOOGLE_SYNC_RETRY_INTERVAL_MS } from './sync-policy.ts';

export type GoogleSyncFailureKind = 'retry' | 'authRequired' | 'error';

export interface GoogleSyncFailureDetails {
  status?: number;
  code?: string;
  retryAfter?: string | null;
  networkFailure?: boolean;
}

export interface GoogleSyncFailureClassification {
  kind: GoogleSyncFailureKind;
  code: string;
  nextRetryAt?: Date;
}

export function classifyGoogleSyncFailure(
  failure: GoogleSyncFailureDetails,
  now: Date,
): GoogleSyncFailureClassification {
  const code = normalizeErrorCode(failure.code, failure.status);
  if (failure.status === 401 || code === 'invalid_grant' || code === 'sign_in_required' || code === 'google_account_mismatch') {
    return { kind: 'authRequired', code };
  }

  const quotaLimited = ['ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded',
    'dailylimitexceeded', 'rate_limit_exceeded', 'quota_exceeded', 'resource_exhausted', 'resource-exhausted'].includes(code);
  if (failure.status === 429 || (quotaLimited && (failure.status === 403 || failure.status === undefined))) {
    const retryAfterTime = parseRetryAfter(failure.retryAfter, now);
    const minimumRetryTime = now.getTime() + GOOGLE_SYNC_RETRY_INTERVAL_MS;
    return {
      kind: 'retry',
      code,
      nextRetryAt: new Date(Math.max(minimumRetryTime, retryAfterTime ?? minimumRetryTime)),
    };
  }

  // Shared Tasks also waits for Firestore creation receipts. Its transient SDK
  // codes have no HTTP status and must not permanently disable automatic retry.
  const transientNetworkCode = ['abort_error', 'dns', 'fetch_failed', 'network', 'network_error', 'offline', 'timeout',
    'aborted', 'deadline-exceeded', 'unavailable']
    .includes(code);
  if (failure.networkFailure || transientNetworkCode || (failure.status !== undefined && failure.status >= 500)) {
    return {
      kind: 'retry',
      code,
      nextRetryAt: new Date(now.getTime() + GOOGLE_SYNC_RETRY_INTERVAL_MS),
    };
  }

  return { kind: 'error', code };
}

function normalizeErrorCode(code: string | undefined, status: number | undefined): string {
  const normalized = code?.trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9_-]+/gu, '_');
  return normalized || (status === undefined ? 'unknown_error' : `http_${status}`);
}

function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const deadline = now.getTime() + seconds * 1000;
    return Number.isFinite(new Date(deadline).getTime()) ? deadline : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}
