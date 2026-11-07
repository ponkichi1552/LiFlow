import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';

const {
  GOOGLE_SYNC_INTERVAL_MS,
  GOOGLE_SYNC_RETRY_INTERVAL_MS,
  GOOGLE_SYNC_STALE_ATTEMPT_MS,
  isGoogleSyncAttemptStale,
  shouldSyncGoogleTasks,
} = await import('../src/features/google-sync/sync-policy.ts');
const { classifyGoogleSyncFailure } = await import('../src/features/google-sync/error-classification.ts');

const t0 = new Date('2026-10-25T00:00:00.000Z');

function state(overrides = {}) {
  return {
    enabled: true,
    status: 'idle',
    lastAttemptAt: null,
    lastSuccessfulSyncAt: null,
    nextRetryAt: null,
    ...overrides,
  };
}

test('Google sync policy includes the first sync and the exact 24-hour boundary', () => {
  assert.equal(shouldSyncGoogleTasks(state(), t0), true);
  assert.equal(shouldSyncGoogleTasks(state({ lastSuccessfulSyncAt: t0.toISOString() }), new Date(t0.getTime() + GOOGLE_SYNC_INTERVAL_MS - 1)), false);
  assert.equal(shouldSyncGoogleTasks(state({ lastSuccessfulSyncAt: t0.toISOString() }), new Date(t0.getTime() + GOOGLE_SYNC_INTERVAL_MS)), true);
});

test('Google sync policy skips disabled, active, errored, and auth-required states', () => {
  for (const overrides of [
    { enabled: false },
    { status: 'syncing' },
    { status: 'error' },
    { status: 'authRequired' },
  ]) {
    assert.equal(shouldSyncGoogleTasks(state(overrides), t0), false);
  }
});

test('retry policy waits until nextRetryAt and retries on the exact boundary', () => {
  const retryAt = new Date(t0.getTime() + GOOGLE_SYNC_RETRY_INTERVAL_MS);
  const pending = state({ status: 'retryPending', nextRetryAt: retryAt.toISOString() });
  assert.equal(shouldSyncGoogleTasks(pending, new Date(retryAt.getTime() - 1)), false);
  assert.equal(shouldSyncGoogleTasks(pending, retryAt), true);
  assert.equal(shouldSyncGoogleTasks(state({ status: 'retryPending' }), t0), false);
});

test('stale syncing state becomes recoverable after ten minutes', () => {
  const syncing = state({ status: 'syncing', lastAttemptAt: t0.toISOString() });
  assert.equal(isGoogleSyncAttemptStale(syncing, new Date(t0.getTime() + GOOGLE_SYNC_STALE_ATTEMPT_MS - 1)), false);
  assert.equal(isGoogleSyncAttemptStale(syncing, new Date(t0.getTime() + GOOGLE_SYNC_STALE_ATTEMPT_MS)), true);
  assert.equal(isGoogleSyncAttemptStale(state(), t0), false);
  assert.equal(isGoogleSyncAttemptStale(state({ status: 'syncing' }), t0), true);
});

test('network, timeout, and server failures retry after one hour', () => {
  for (const failure of [{ networkFailure: true }, { code: 'timeout' }, { status: 503 }]) {
    const result = classifyGoogleSyncFailure(failure, t0);
    assert.equal(result.kind, 'retry');
    assert.equal(result.nextRetryAt?.getTime(), t0.getTime() + GOOGLE_SYNC_RETRY_INTERVAL_MS);
  }
});

test('401 and invalid_grant require reconnection; permanent client errors do not retry', () => {
  assert.equal(classifyGoogleSyncFailure({ status: 401 }, t0).kind, 'authRequired');
  assert.equal(classifyGoogleSyncFailure({ code: 'invalid_grant' }, t0).kind, 'authRequired');
  assert.deepEqual(classifyGoogleSyncFailure({ status: 400 }, t0), { kind: 'error', code: 'http_400' });
});

test('429 honors Retry-After without retrying earlier than one hour', () => {
  const oneHour = t0.getTime() + GOOGLE_SYNC_RETRY_INTERVAL_MS;
  const shorter = classifyGoogleSyncFailure({ status: 429, retryAfter: '30' }, t0);
  assert.equal(shorter.nextRetryAt?.getTime(), oneHour);
  const longer = classifyGoogleSyncFailure({ status: 429, retryAfter: '7200' }, t0);
  assert.equal(longer.nextRetryAt?.getTime(), t0.getTime() + 7_200_000);
  const dateHeader = new Date(t0.getTime() + 5_000_000).toUTCString();
  assert.equal(classifyGoogleSyncFailure({ status: 429, retryAfter: dateHeader }, t0).nextRetryAt?.getTime(), t0.getTime() + 5_000_000);
});

test('HTTP 403 quota limits retry while genuine permission failures remain permanent', () => {
  for (const code of ['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'RESOURCE_EXHAUSTED']) {
    const result = classifyGoogleSyncFailure({ status: 403, code, retryAfter: '7200' }, t0);
    assert.equal(result.kind, 'retry');
    assert.equal(result.nextRetryAt?.getTime(), t0.getTime() + 7_200_000);
  }
  assert.equal(classifyGoogleSyncFailure({ status: 403, code: 'insufficientPermissions' }, t0).kind, 'error');
  assert.equal(classifyGoogleSyncFailure({ status: 403, code: 'PERMISSION_DENIED' }, t0).kind, 'error');
});

test('Firestore transient and quota codes without HTTP status retry while authority and schema failures stay blocked', () => {
  for (const code of ['unavailable', 'deadline-exceeded', 'aborted', 'resource-exhausted']) {
    const result = classifyGoogleSyncFailure({ code }, t0);
    assert.equal(result.kind, 'retry'); assert.equal(result.code, code);
    assert.equal(result.nextRetryAt.getTime(), t0.getTime() + GOOGLE_SYNC_RETRY_INTERVAL_MS);
  }
  assert.equal(classifyGoogleSyncFailure({ code: 'resource-exhausted', retryAfter: '7200' }, t0).nextRetryAt.getTime(), t0.getTime() + 7_200_000);
  for (const code of ['permission-denied', 'unauthenticated', 'failed-precondition', 'invalid-argument']) {
    assert.deepEqual(classifyGoogleSyncFailure({ code }, t0), { kind: 'error', code });
  }
});

test('audit100 a backward clock correction cannot pin automatic Tasks synchronization to a future attempt or success timestamp', () => {
  const future = new Date(t0.getTime() + 86400_000).toISOString();
  assert.equal(isGoogleSyncAttemptStale(state({ status: 'syncing', lastAttemptAt: future }), t0), true);
  assert.equal(shouldSyncGoogleTasks(state({ lastSuccessfulSyncAt: future }), t0), true);
});
