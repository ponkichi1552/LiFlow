import { getSharingServices, isSharingConfigured } from './firebase-services';
import { nativePrivatePlannerPreferences } from './private-calendar-secrets';
import { readLocalAdaptiveWorkspace, sharingLocalPlanningRevision } from './workspaces';
import { setNativeAdaptiveOwnerReader, AdaptiveOwnerInputsChangedError } from '../storage/adaptive-owner-inputs';
import { addDays } from '../../domain/scheduling/local-date';
import { sharedLocalDate } from '../../features/sharing/group-clock';
import { notifyGooglePlannerChanges } from '../../features/google-sync/planner-change-events';
import { readCalendarEventRows } from '../storage/calendar-event-rows';
import { openPrivateCalendarRuntime } from './private-calendar-runtime';
import { buildV2PersonalPlan } from '../../features/sharing/v2/personal-plan';
import { createLocalCalendarAvailability } from '../../features/calendar/private-availability';
import { sharedCalendarAvailability } from '../../features/calendar/shared-events';
import { combinePrivateCalendarAvailability } from '../../features/sharing/v2/private-availability';
import { adaptivePersonalDigest } from '../../features/planner/adaptive-digest';
import { CALENDAR_AVAILABILITY_MAX_AGE_MS } from '../../features/google-sync/calendar-timing';
import type { PrivateBusyPlacementInput } from '../../features/planner/private-busy-input';
import type { PrivateCalendarRuntime } from '../../features/sharing/private-calendar/runtime';
import type { FrequencyMode } from '../../domain/chores/types';
import type { Weekday } from '../../domain/shared/types';

let preferenceOwner: string | null = null; let preferenceRevision = 0; let unsubscribe: (() => void) | undefined;
let calendarRuntime: PrivateCalendarRuntime | undefined; let calendarRevision = 0; let stopCalendar: (() => void) | undefined;
const currentUser = () => isSharingConfigured() ? getSharingServices().auth.currentUser?.uid ?? null : null;
/** Installed in foreground and the sole headless worker. All inputs come from local protected stores. */
setNativeAdaptiveOwnerReader(async (now, database) => {
  const ownerUserId = currentUser();
  if (preferenceOwner !== ownerUserId) {
    unsubscribe?.(); stopCalendar?.(); unsubscribe = undefined; stopCalendar = undefined; calendarRuntime = undefined;
    preferenceOwner = ownerUserId; preferenceRevision++; calendarRevision++;
    if (ownerUserId) unsubscribe = nativePrivatePlannerPreferences(ownerUserId).subscribe(() => {
      preferenceRevision++; notifyGooglePlannerChanges();
    });
    if (ownerUserId) {
      calendarRuntime = openPrivateCalendarRuntime(ownerUserId);
      stopCalendar = calendarRuntime.subscribe(() => { calendarRevision++; notifyGooglePlannerChanges(); });
    }
  }
  const preferencesAt = preferenceRevision; const calendarAt = calendarRevision; const sharedAt = sharingLocalPlanningRevision();
  let calendarValidThrough: number | undefined;
  const assertCurrent = () => {
    if (currentUser() !== ownerUserId || preferenceRevision !== preferencesAt || calendarRevision !== calendarAt
      || sharingLocalPlanningRevision() !== sharedAt || calendarValidThrough !== undefined && Date.now() > calendarValidThrough) throw new AdaptiveOwnerInputsChangedError();
  };
  if (!ownerUserId) return { ownerUserId: null, preferences: null, common: null, assertCurrent };
  const store = nativePrivatePlannerPreferences(ownerUserId);
  const preferences = await store.read(); assertCurrent();
  const runtime = calendarRuntime!;
  const readCalendarInput = async (): Promise<PrivateBusyPlacementInput> => {
    try {
      const settings = await runtime.readSettings(); const busy = await runtime.readForPlan(); assertCurrent();
      if (settings.ownerUserId !== ownerUserId || busy && (busy.ownerUserId !== ownerUserId
        || busy.binding.ownerUserId !== ownerUserId || busy.cache.ownerUserId !== ownerUserId)) throw new AdaptiveOwnerInputsChangedError();
      return { ownerUserId, connected: settings.connected || Boolean(busy), cache: busy?.cache ?? null, binding: busy?.binding ?? null };
    } catch (error) {
      assertCurrent(); if (error instanceof AdaptiveOwnerInputsChangedError) throw error;
      // An unreadable protected source is unknown, never proof of an empty calendar.
      return { ownerUserId, connected: true, cache: null, binding: null };
    }
  };
  const privateCalendar = await readCalendarInput(); const calendarSignature = adaptivePersonalDigest(privateCalendar);
  const fetchedAt = Date.parse(privateCalendar.cache?.fetchedAt ?? '');
  if (Number.isFinite(fetchedAt) && fetchedAt <= now.getTime() && fetchedAt + CALENDAR_AVAILABILITY_MAX_AGE_MS >= now.getTime()) {
    calendarValidThrough = fetchedAt + CALENDAR_AVAILABILITY_MAX_AGE_MS;
  }
  assertCurrent();
  const workspace = await readLocalAdaptiveWorkspace(ownerUserId); assertCurrent();
  const acceptedRecord = workspace ? await workspace.record() : null;
  const sharedVersion = async () => {
    const value = (await workspace!.database.getFirstAsync<{ data_version: number }>('PRAGMA data_version'))?.data_version;
    if (!Number.isSafeInteger(value) || value! < 1) throw new AdaptiveOwnerInputsChangedError(); return value;
  };
  const version = workspace ? await sharedVersion() : undefined;
  const model = workspace ? await workspace.session.controller.readModel(({ timeZone }) => {
    const today = sharedLocalDate(now, timeZone); return { from: addDays(today, -30), through: addDays(today, 180), asOfDate: today };
  }) : null;
  assertCurrent();
  if (workspace && version !== await sharedVersion()) throw new AdaptiveOwnerInputsChangedError();
  const assertCommitCurrent = async () => {
    assertCurrent(); const latest = await store.read(); assertCurrent();
    if ((latest?.revision ?? 0) !== (preferences?.revision ?? 0)) throw new AdaptiveOwnerInputsChangedError();
    if (adaptivePersonalDigest(await readCalendarInput()) !== calendarSignature) throw new AdaptiveOwnerInputsChangedError();
    if (workspace) {
      const current = await workspace.record(); assertCurrent();
      if (!['active', 'creating'].includes(current.status) || current.localGeneration !== acceptedRecord?.localGeneration) throw new AdaptiveOwnerInputsChangedError();
      if (version !== await sharedVersion()) throw new AdaptiveOwnerInputsChangedError();
    }
  };
  const common = model?.plan.initialized ? model.plan : null;
  if (!common) return { ownerUserId, preferences, common, privateCalendar, assertCurrent, assertCommitCurrent };
  const local = await database.getFirstAsync<{ frequency_mode: FrequencyMode; rest_days_json: string; heavy_daily_limit: number; normal_daily_limit: number }>(
    "SELECT * FROM household_settings WHERE household_id='local-household'");
  const calendar = await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_events'")
    ? await readCalendarEventRows(database) : { events: [], exceptions: [] };
  // Shared recommendations are calculated first from private calendar/settings,
  // never from the private chores that will be placed around them. No feedback loop.
  const personal = buildV2PersonalPlan(common, { viewerUserId: ownerUserId, now: now.getTime(), settings: {
    frequencyMode: local?.frequency_mode ?? 'balanced', restDays: preferences?.restDays ?? JSON.parse(local?.rest_days_json ?? '[]') as Weekday[],
    loadLimits: preferences?.loadLimits ?? { heavyDailyLimit: local?.heavy_daily_limit ?? 1, normalDailyLimit: local?.normal_daily_limit ?? 2 } },
    localCalendar: { ownerUserId, availability: combinePrivateCalendarAvailability(
      createLocalCalendarAvailability(calendar.events, calendar.exceptions, common.range, common.timeZone),
      sharedCalendarAvailability(model!.calendar, common.groupId, common.range, common.timeZone)) },
    ...(privateCalendar.cache && privateCalendar.binding ? { calendar: { cache: privateCalendar.cache, binding: privateCalendar.binding } } : {}) });
  assertCurrent();
  return { ownerUserId, preferences, common, privateCalendar, sharedCalendar: model!.calendar, assertCurrent, assertCommitCurrent,
    sharedPlanning: { ownerUserId, groupId: common.groupId, sourceHash: common.sourceHash, plan: personal } };
});
