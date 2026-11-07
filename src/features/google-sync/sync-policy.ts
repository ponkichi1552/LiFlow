export type GoogleSyncStatus = 'idle' | 'syncing' | 'retryPending' | 'authRequired' | 'error';

export interface GoogleSyncPolicyState {
  enabled: boolean;
  status: GoogleSyncStatus;
  lastAttemptAt?: string | null;
  lastSuccessfulSyncAt?: string | null;
  nextRetryAt?: string | null;
}

export const GOOGLE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GOOGLE_SYNC_RETRY_INTERVAL_MS = 60 * 60 * 1000;
export const GOOGLE_SYNC_STALE_ATTEMPT_MS = 10 * 60 * 1000;

export interface GoogleSyncTriggerOptions {
  force?: boolean;
  trigger?: 'manual' | 'completion';
  budgetMs?: number;
  /** Background workers may resume delta pages, but cannot start a full inventory scan. */
  deltaOnly?: boolean;
}

/** Keep task forcing, Calendar cadence and interrupted-attempt recovery independent. */
export function googleSyncRunOptions(options: GoogleSyncTriggerOptions) {
  return {
    force: options.force ?? false,
    forceCalendar: options.force === true && options.trigger !== 'completion',
    // Live attempts are joined by the coordinator's in-memory promise/operation
    // queue. A persisted marker on a forced run may belong to a killed process.
    recoverInterruptedAttempt: options.force === true || options.trigger === 'completion',
    ...(options.deltaOnly ? { deltaOnly: true } : {}),
  };
}

/** The clock is injected so the 24-hour and retry boundaries are deterministic in tests. */
export function shouldSyncGoogleTasks(state: GoogleSyncPolicyState | null, now: Date): boolean {
  if (!state?.enabled) return false;
  if (state.status === 'authRequired' || state.status === 'syncing' || state.status === 'error') return false;

  if (state.status === 'retryPending') {
    const attempted = parseTimestamp(state.lastAttemptAt);
    if (attempted !== null && attempted > now.getTime()) return true;
    const retryAt = parseTimestamp(state.nextRetryAt);
    return retryAt !== null && retryAt <= now.getTime();
  }

  const lastSuccess = parseTimestamp(state.lastSuccessfulSyncAt);
  return lastSuccess === null || lastSuccess > now.getTime() || lastSuccess + GOOGLE_SYNC_INTERVAL_MS <= now.getTime();
}

export function isGoogleSyncAttemptStale(state: GoogleSyncPolicyState, now: Date): boolean {
  if (state.status !== 'syncing') return false;
  const lastAttempt = parseTimestamp(state.lastAttemptAt);
  return lastAttempt === null || lastAttempt > now.getTime() || lastAttempt + GOOGLE_SYNC_STALE_ATTEMPT_MS <= now.getTime();
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
