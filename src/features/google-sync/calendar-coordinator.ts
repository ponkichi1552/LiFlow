import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '@/domain/shared/types';
import {
  commitCalendarAvailabilitySuccess, listEntriesForGoogleSync, listGoogleTaskLinks,
  loadCalendarAvailabilityState, loadPlannerSnapshot, plannerGenerationRange, saveCalendarAvailabilityState, readCalendarPlanningSignatures,
  hasFreshCalendarCoverage,
} from '@/platform/storage/repository';
import { createCalendarFreeBusyClient, CalendarFreeBusyError } from '@/platform/google-tasks/google-calendar-freebusy-client';
import type { CalendarFreeBusyClient } from '@/platform/google-tasks/google-calendar-freebusy-client';
import {
  aggregateBusyMinutes, CalendarPermissionRequiredError, createCalendarQueryRange, getDeviceTimeZone, shouldRefreshCalendar,
} from './calendar-availability';
import type { CalendarAvailabilityDay, CalendarAvailabilityState, CalendarQueryRange } from './calendar-availability';
import { classifyGoogleSyncFailure } from './error-classification';
import { notifyGooglePlannerChanges } from './planner-change-events';
import { withinGoogleOperationBudget } from './operation-budget.ts';
import type { GoogleOperationBudget } from './operation-budget';

export interface CalendarCoordinatorPort {
  loadState(): Promise<CalendarAvailabilityState | null>;
  saveState(state: CalendarAvailabilityState): Promise<void>;
  getAccessToken(): Promise<string>;
  client: CalendarFreeBusyClient;
  commitSuccess(days: readonly CalendarAvailabilityDay[], state: CalendarAvailabilityState): Promise<void>;
  regeneratePlanner(): Promise<boolean>;
  readPlanningSignatures(): Promise<{ current: string; applied: string | null }>;
  hasFreshCoverage?(range: CalendarQueryRange, now: Date): Promise<boolean>;
}

export async function refreshCalendarWithDependencies(
  port: CalendarCoordinatorPort, options: { now: Date; range: CalendarQueryRange; force?: boolean; budget?: GoogleOperationBudget },
): Promise<{ kind: string; plannerChanged: boolean; days?: number; busyDays?: number }> {
  let state = await port.loadState();
  if (!state?.enabled) return { kind: 'disabled', plannerChanged: false };
  let kind = 'skipped';
  let days: CalendarAvailabilityDay[] | undefined;
  const missingCoverage = state.status === 'idle' && port.hasFreshCoverage
    ? !(await port.hasFreshCoverage(options.range, options.now)) : false;
  if (shouldRefreshCalendar(state, options.now, options.force) || missingCoverage) {
    const timestamp = options.now.toISOString();
    state = { ...state, status: 'syncing', lastAttemptAt: timestamp, nextRetryAt: undefined, updatedAt: timestamp };
    await port.saveState(state);
    try {
      const wait = <T>(work: () => Promise<T>) => options.budget ? withinGoogleOperationBudget(options.budget, work) : work();
      const token = await wait(port.getAccessToken);
      const busy = await wait(() => port.client.query(token, options.range, options.budget
        ? { signal: options.budget.signal, timeoutMs: options.budget.remaining() } : undefined));
      days = aggregateBusyMinutes(busy, options.range, timestamp);
      options.budget?.assert();
      await port.commitSuccess(days, { ...state, status: 'idle', retryCount: 0,
        lastSuccessfulSyncAt: timestamp, nextRetryAt: undefined, lastErrorCode: undefined, updatedAt: timestamp });
      kind = 'success';
    } catch (error) {
      const api = error instanceof CalendarFreeBusyError ? error : undefined;
      const nativeCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const nativeUnavailable = nativeCode === 'NO_ACTIVITY' || nativeCode === 'IN_PROGRESS';
      const permission = error instanceof CalendarPermissionRequiredError || api?.code === 'calendar_permission_required'
        || nativeCode === 'SIGN_IN_REQUIRED'
        || nativeCode === 'google_account_mismatch'
        || (error instanceof Error && error.name === 'GoogleSignInRequiredError');
      const failure = classifyGoogleSyncFailure({
        // Google Calendar can return rateLimitExceeded as either 403 or 429.
        status: api?.code === 'calendar_rate_limited' ? 429 : api?.status,
        code: api?.code ?? (error instanceof Error && error.name === 'AbortError' ? 'timeout'
          : nativeUnavailable ? 'calendar_native_operation_unavailable'
            : error instanceof TypeError ? 'network_error' : 'calendar_refresh_failed'),
        retryAfter: api?.retryAfter,
        // The Android SDK also uses IN_PROGRESS when no foreground Activity is available.
        networkFailure: nativeUnavailable,
      }, options.now);
      kind = permission ? 'permissionRequired' : failure.kind === 'retry' ? 'retryPending' : 'error';
      await port.saveState({ ...state, status: kind as CalendarAvailabilityState['status'],
        retryCount: kind === 'retryPending' ? state.retryCount + 1 : state.retryCount,
        nextRetryAt: failure.kind === 'retry' ? failure.nextRetryAt?.toISOString() : undefined,
        lastErrorCode: permission ? 'calendar_permission_required' : failure.code, updatedAt: timestamp });
    }
  }
  if (options.budget) try { options.budget.assert(); } catch { return { kind, plannerChanged: false }; }
  // Fresh cache may survive a failure; stale/missing cache is omitted by the repository.
  const signatures = await port.readPlanningSignatures();
  const plannerChanged = signatures.current === signatures.applied ? false : await port.regeneratePlanner();
  return { kind, plannerChanged, ...(days ? { days: days.length, busyDays: days.filter((day) => day.busyMinutes > 0).length } : {}) };
}

/** Called inside the existing Google sync mutex, before Tasks reconciliation. */
export async function refreshGoogleCalendarAvailability(
  database: SQLiteDatabase, options: { now: Date; today: LocalDate; force: boolean; budget?: GoogleOperationBudget },
): Promise<{ plannerChanged: boolean }> {
  const startedAt = Date.now();
  let requests = 0;
  const range = createCalendarQueryRange(...calendarRangeArguments(options.today));
  const client = createCalendarFreeBusyClient(fetch, () => { requests += 1; });
  const result = await refreshCalendarWithDependencies({
    loadState: () => loadCalendarAvailabilityState(database),
    saveState: (state) => saveCalendarAvailabilityState(database, state),
    getAccessToken: async () => {
      const { getBoundGoogleAccessToken } = await import('@/platform/google-tasks/bound-session');
      return getBoundGoogleAccessToken(database, 'calendar');
    },
    client,
    commitSuccess: (days, state) => commitCalendarAvailabilitySuccess(database, days, state),
    readPlanningSignatures: () => readCalendarPlanningSignatures(database, options.now, range.timeZone),
    hasFreshCoverage: (coverage, now) => hasFreshCalendarCoverage(database, coverage, now),
    regeneratePlanner: async () => {
      const before = await listEntriesForGoogleSync(database, options.today);
      const snapshot = await loadPlannerSnapshot(database, options.today, options.now, range.timeZone);
      const completedIds = new Set(snapshot.completions.filter((completion) => completion.outcome === 'completed')
        .map((completion) => completion.scheduleEntryId));
      const after = snapshot.scheduleEntries.filter((entry) => (entry.status !== 'initialPending' || entry.id.startsWith('personal-round.')) && !completedIds.has(entry.id));
      const beforeDates = new Map(before.filter((item) => !item.completedAt).map(({ entry }) => [entry.id, entry.suggestedDate]));
      const links = new Map((await listGoogleTaskLinks(database)).map((link) => [link.scheduleEntryId, link]));
      const changed = beforeDates.size !== after.length || after.some((entry) =>
        (beforeDates.get(entry.id) !== entry.suggestedDate ||
          (links.has(entry.id) && links.get(entry.id)?.lastSyncedDueDate !== entry.suggestedDate)));
      if (changed) {
        const handled = notifyGooglePlannerChanges();
        if (!handled) try {
          const { refreshPlannerAfterGoogleImport } = await import('@/platform/google-tasks/refresh-planner-after-google-import');
          await refreshPlannerAfterGoogleImport(database, options.today, snapshot);
        } catch { /* Calendar optimization never requires native widget/notification availability. */ }
      }
      return changed;
    },
  }, { now: options.now, range, force: options.force, budget: options.budget });
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info('[google-calendar]', { result: result.kind, durationMs: Date.now() - startedAt, requests,
      days: result.days ?? 0, busyDays: result.busyDays ?? 0,
      from: range.from, through: range.through, timeZone: range.timeZone,
      timeMin: range.timeMin, timeMax: range.timeMax });
  }
  return { plannerChanged: result.plannerChanged };
}

function calendarRangeArguments(today: LocalDate): [LocalDate, LocalDate, string] {
  const { from, through } = plannerGenerationRange(today);
  return [from, through, getDeviceTimeZone()];
}
