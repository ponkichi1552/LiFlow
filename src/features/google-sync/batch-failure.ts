import { GoogleTasksApiError } from '../../platform/google-tasks/google-tasks-api.ts';
import type { GoogleTasksBatchItemResult } from '../../platform/google-tasks/google-tasks-api';

/** Every unresolved response contributes its wait; response order has no meaning. */
export function googleTaskBatchFailure(results: readonly GoogleTasksBatchItemResult[], receivedAt = Date.now()): GoogleTasksApiError | undefined {
  const failures = results.filter(result => !result.ok);
  if (!failures.length) return undefined;
  const rank = (status: number) => status === 401 ? 0 : status === 429 ? 1 : status < 500 ? 2 : 3;
  const selected = [...failures].sort((a, b) => rank(a.status) - rank(b.status) || a.status - b.status || a.code.localeCompare(b.code))[0];
  let deadline = 0;
  for (const failure of failures) {
    if (!failure.retryAfter) continue;
    const seconds = Number(failure.retryAfter);
    const value = Number.isFinite(seconds) && seconds >= 0 ? receivedAt + seconds * 1000 : Date.parse(failure.retryAfter);
    if (Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) deadline = Math.max(deadline, value);
  }
  return new GoogleTasksApiError(selected.status, selected.code, deadline ? new Date(deadline).toISOString() : null);
}
