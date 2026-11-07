import type { SQLiteDatabase } from 'expo-sqlite';
import type { CalendarEvent, CalendarException, EventDraft } from '../../domain/calendar/events';
import type { ChoreDefinition, ChoreScheduleEntry, ChoreState, FrequencyMode } from '../../domain/chores/types';
import type { LocalDate, Weekday } from '../../domain/shared/types';
import type { AdaptiveLocalPreferences } from '../../features/planner/adaptive-input';
import { prepareAdaptivePlacementInput } from '../../features/planner/adaptive-input.ts';
import { addDays, localDateFromDate } from '../../domain/scheduling/local-date.ts';
import { parseSharedMirrorEntryId } from '../../features/planner/common-chore-links.ts';
import { adaptivePersonalDigest } from '../../features/planner/adaptive-digest.ts';
import { readCalendarEventRows } from './calendar-event-rows.ts';
import { personalAdaptiveSourceRevision } from './personal-adaptive-planner.ts';
import type { PersonalAdaptiveContext } from './personal-adaptive-planner';
import { CALENDAR_AVAILABILITY_MAX_AGE_MS, createCalendarQueryRange } from '../../features/google-sync/calendar-availability.ts';
import { unionInstantSpans } from '../../domain/scheduling/adaptive/placement.ts';
import type { AdaptivePlacementLoad } from '../../domain/scheduling/adaptive/placement';
import { usesPersonalAdaptivePlanner } from '../../domain/chores/personal-catalog.ts';
import { clothingRegionFor } from '../../domain/scheduling/adaptive/seasonal.ts';
import { resolveWeatherMunicipality } from '../../features/weather/municipality-search.ts';
import { readRegionalWeatherInside } from './regional-weather.ts';
import { weatherCacheFreshness } from '../../features/weather/met-server-provider.ts';
import { personalChoreUsesWeather } from '../../features/weather/chore-weather.ts';
import { readAdaptiveOwnerInputs } from './adaptive-owner-inputs.ts';
import { sharedAdaptiveLoad } from '../../features/planner/shared-adaptive-load.ts';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { projectSharedCalendarPlanningRecords } from '../../features/calendar/shared-events.ts';
import { privateBusyPlacement } from '../../features/planner/private-busy-input.ts';
import { snapshotPersonalPlacementPreferences } from '../../features/planner/personal-placement-preferences.ts';

/** Serialized private settings stay local and never enter a shared event or Google payload. */
export type PersonalAdaptivePreferences = Pick<AdaptiveLocalPreferences, 'allowedBands' | 'dayOverrides' | 'maximumMinutes'>;
const timing = (event: EventDraft & { blocksTime?: boolean }) => [event.startDate, event.endDate, event.allDay, event.startMinute,
  event.endMinute, event.timeZone, event.recurrence, event.untilDate, event.customRecurrence, event.birthday, event.blocksTime];
export function adaptiveCalendarTiming(events: readonly CalendarEvent[], exceptions: readonly CalendarException[]) {
  return [events.map(event => [event.id, timing(event)]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    exceptions.map(row => [row.eventId, row.anchorDate, row.override ? timing({ ...row.override,
      ...('blocksTime' in row ? { blocksTime: row.blocksTime as boolean } : {}) }) : null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
}
async function privateGoogleCoverageInside(database: SQLiteDatabase, householdId: string, from: LocalDate, through: LocalDate, timeZone: string) {
  const state = await database.getFirstAsync<{ enabled: number; account_subject: string | null }>(`SELECT a.enabled,g.account_subject FROM calendar_availability_state a
    LEFT JOIN google_sync_state g ON g.household_id=a.household_id WHERE a.household_id=?`, householdId);
  const days = state?.enabled ? await database.getAllAsync<{ local_date: LocalDate; busy_minutes: number; time_zone: string; fetched_at: string }>(
    'SELECT * FROM calendar_availability_days WHERE household_id=? ORDER BY local_date', householdId) : [];
  let mirror: { enabled: boolean; complete: boolean; subject: string; lastSyncAt: string | null; error: string | null } | null = null;
  if (await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_google_control'")) {
    try {
      const row = await database.getFirstAsync<{ control_json: string }>('SELECT control_json FROM calendar_google_control WHERE singleton=1');
      if (row) {
        const control = JSON.parse(row.control_json);
        if (control.enabled === true && typeof control.subject === 'string' && (control.lastSyncAt === null || typeof control.lastSyncAt === 'string')
          && Array.isArray(control.calendars) && control.calendars.length > 0 && control.calendars.length <= 1000) {
          const ids = new Set<string>(control.calendars.map((calendar: { id: string }) => calendar.id));
          const [cursors, progress, inbox, expansions] = await Promise.all([
            database.getAllAsync<{ calendar_id: string; sync_token: string | null; page_token: string | null; scan_id: string | null }>(
              'SELECT * FROM calendar_google_cursors WHERE subject=?', control.subject),
            database.getFirstAsync<{ remaining_json: string }>('SELECT remaining_json FROM calendar_google_progress WHERE subject=?', control.subject),
            database.getAllAsync<{ calendar_id: string }>('SELECT DISTINCT calendar_id FROM calendar_google_inbox WHERE subject=? AND dirty<>0', control.subject),
            database.getAllAsync<{ calendar_id: string; active: number; range_json: string }>(
              'SELECT calendar_id,active,range_json FROM calendar_google_expansion WHERE subject=?', control.subject),
          ]);
          const required = createCalendarQueryRange(from, through, timeZone);
          const byId = new Map(cursors.map(cursor => [cursor.calendar_id, cursor]));
          const remaining: unknown = progress ? JSON.parse(progress.remaining_json) : [];
          // A requested display range is an intention, not proof of received events.
          // Supported series are complete with their full events.list cursor. Unsupported
          // rules require an actually finished instances traversal covering this horizon.
          const complete = [...ids].every(id => typeof id === 'string' && id.length > 0 && byId.get(id)?.sync_token
            && !byId.get(id)?.page_token && !byId.get(id)?.scan_id)
            && Array.isArray(remaining) && !remaining.some(id => ids.has(id))
            && !inbox.some(row => ids.has(row.calendar_id))
            && expansions.filter(row => ids.has(row.calendar_id)).every(row => {
              const range = JSON.parse(row.range_json);
              return row.active === 0 && Date.parse(range.timeMin) <= Date.parse(required.timeMin)
                && Date.parse(range.timeMax) >= Date.parse(required.timeMax);
            });
          mirror = { enabled: true, complete, subject: control.subject, lastSyncAt: control.lastSyncAt, error: control.error };
        }
      }
    } catch { /* An unreadable mirror never grants invented free time. */ }
  }
  return { enabled: Boolean(state?.enabled), subject: state?.account_subject ?? null, days, mirror };
}
export async function readPersonalAdaptiveContextInside(database: SQLiteDatabase, input: {
  householdId: string; memberId: string; now: Date; timeZone: string; today?: LocalDate; assertInputsCurrent?(): void | Promise<void>;
}): Promise<PersonalAdaptiveContext | null> {
  const rows = await database.getAllAsync<{ id: string; enabled: number; definition_json: string }>(
    'SELECT id,enabled,definition_json FROM chore_definitions WHERE household_id=?', input.householdId);
  const chores = rows.map(row => ({ ...JSON.parse(row.definition_json) as ChoreDefinition, enabled: Boolean(row.enabled) }));
  if (!chores.some(usesPersonalAdaptivePlanner)) return null;
  const settings = await database.getFirstAsync<{ frequency_mode: FrequencyMode; setup_completed: number; rest_days_json: string;
    heavy_daily_limit: number; normal_daily_limit: number; created_at: string; weather_region: string | null; weather_region_name: string | null;
    weather_municipality_id: string | null; weather_latitude: number | null; weather_longitude: number | null }>(`SELECT s.*,h.created_at FROM household_settings s
    JOIN households h ON h.id=s.household_id WHERE s.household_id=?`, input.householdId);
  if (!settings?.setup_completed) return null;
  const owner = await readAdaptiveOwnerInputs(database, input.now);
  const timeZone = owner?.preferences?.timeZone ?? input.timeZone;
  const today = owner?.preferences ? sharedLocalDate(input.now, timeZone) : input.today ?? localDateFromDate(input.now);
  const municipality = resolveWeatherMunicipality(settings.weather_region && settings.weather_region_name
    && settings.weather_latitude !== null && settings.weather_longitude !== null ? { region: settings.weather_region,
      displayName: settings.weather_region_name, municipalityId: settings.weather_municipality_id ?? undefined,
      latitude: settings.weather_latitude, longitude: settings.weather_longitude } : null);
  const usesWeather = chores.some(chore => chore.enabled && !chore.archived && personalChoreUsesWeather(chore));
  const [stateRows, entryRows, completions, assignmentRows, pref, calendar, googleCoverage, weather] = await Promise.all([
    database.getAllAsync<{ chore_id: string; last_completed_date: LocalDate | null; last_completed_estimated: number; initial_pending: number }>(
      'SELECT s.* FROM chore_state s JOIN chore_definitions d ON d.id=s.chore_id WHERE d.household_id=?', input.householdId),
    database.getAllAsync<{ entry_json: string }>('SELECT entry_json FROM chore_schedule_entries WHERE household_id=?', input.householdId),
    database.getAllAsync<{ id: string; chore_id: string; schedule_entry_id: string | null; completed_at: string;
      completed_local_date: LocalDate | null; completed_by_member_id: string | null }>(`SELECT * FROM chore_completions
      WHERE household_id=? AND outcome='completed' AND (completed_local_date=? OR completed_local_date IS NULL AND completed_at>=?)`,
    input.householdId, today, addDays(today, -2)),
    database.getAllAsync<{ chore_id: string; member_id: string }>(`SELECT a.* FROM chore_assignments a JOIN chore_definitions d ON d.id=a.chore_id WHERE d.household_id=?`, input.householdId),
    owner?.preferences ? Promise.resolve(null) : database.getFirstAsync<{ preferences_json: string }>('SELECT preferences_json FROM personal_adaptive_preferences WHERE household_id=?', input.householdId),
    readCalendarEventRows(database),
    privateGoogleCoverageInside(database, input.householdId, today, addDays(today, 180), timeZone),
    readRegionalWeatherInside(database, usesWeather ? municipality?.id : null),
  ]);
  const own = snapshotPersonalPlacementPreferences(pref ? JSON.parse(pref.preferences_json) : { allowedBands: [], dayOverrides: [] });
  const preferences: AdaptiveLocalPreferences = { ...own, restDays: owner?.preferences?.restDays ?? JSON.parse(settings.rest_days_json) as Weekday[],
    heavyLimit: owner?.preferences?.loadLimits.heavyDailyLimit ?? settings.heavy_daily_limit,
    normalLimit: owner?.preferences?.loadLimits.normalDailyLimit ?? settings.normal_daily_limit,
    ...(owner?.preferences ? { allowedBands: owner.preferences.allowedBands, dayOverrides: owner.preferences.dayOverrides ?? [],
      maximumMinutes: owner.preferences.maximumMinutes } : {}) };
  const now = input.now.toISOString();
  const clothingRegion = clothingRegionFor(municipality);
  const states: ChoreState[] = stateRows.map(row => ({ choreId: row.chore_id, lastCompletedDate: row.last_completed_date ?? undefined,
    lastCompletedEstimated: Boolean(row.last_completed_estimated), initialPending: Boolean(row.initial_pending) }));
  const choresById = new Map(chores.map(chore => [chore.id, chore]));
  const shared = owner?.common && owner.ownerUserId ? sharedAdaptiveLoad(owner.common, owner.ownerUserId, today, timeZone, chores, owner.sharedPlanning?.plan)
    : { loads: [], suppressedPersonalChoreIds: new Set<string>() };
  const sharedCalendar = owner?.common ? projectSharedCalendarPlanningRecords(owner.sharedCalendar ?? [], owner.common.groupId) : null;
  const calendarInput = { events: [...calendar.events, ...sharedCalendar?.events ?? []], exceptions: [...calendar.exceptions, ...sharedCalendar?.exceptions ?? []] };
  const assignments = new Map<string, string[]>();
  for (const row of assignmentRows) assignments.set(row.chore_id, [...(assignments.get(row.chore_id) ?? []), row.member_id]);
  const completedEntries = new Set(completions.map(row => row.schedule_entry_id));
  const seasonalPendingRoundIds = new Set<string>();
  const fixedLoads: AdaptivePlacementLoad[] = entryRows.flatMap(row => {
    const entry = JSON.parse(row.entry_json) as ChoreScheduleEntry; const chore = choresById.get(entry.choreId);
    if (!chore || shared.suppressedPersonalChoreIds.has(chore.id) || usesPersonalAdaptivePlanner(chore) && chore.personalSchedulingKind !== 'seasonal' || !chore.enabled || chore.archived || completedEntries.has(entry.id)) return [];
    if (chore.personalSchedulingKind === 'seasonal') seasonalPendingRoundIds.add(entry.id);
    return [{ roundId: entry.id, date: entry.suggestedDate, minutes: chore.estimatedMinutes ?? null, load: chore.load, slot: null }];
  });
  for (const row of completions) {
    const chore = choresById.get(row.chore_id);
    if (!chore || parseSharedMirrorEntryId(row.schedule_entry_id) || row.completed_by_member_id && row.completed_by_member_id !== input.memberId
      || (row.completed_local_date ?? sharedLocalDate(new Date(row.completed_at), timeZone)) !== today) continue;
    fixedLoads.push({ roundId: row.schedule_entry_id ?? `completed:${row.id}`, date: today, minutes: chore.estimatedMinutes ?? null, load: chore.load, slot: null });
  }
  fixedLoads.push(...shared.loads);
  // Own SQLite data determines this stable identity; a Google/Firebase login is not required for local planning.
  const ownerId = adaptivePersonalDigest([input.householdId, settings.created_at, input.memberId]);
  const mirrored = googleCoverage.mirror; const fetched = Date.parse(mirrored?.lastSyncAt ?? '');
  const exactMirror = Boolean(mirrored?.enabled && mirrored.complete && (!googleCoverage.enabled || googleCoverage.subject && mirrored.subject === googleCoverage.subject) && !mirrored.error
    && fetched <= input.now.getTime() && input.now.getTime() - fetched <= CALENDAR_AVAILABILITY_MAX_AGE_MS);
  const privateBusy = privateBusyPlacement(owner?.privateCalendar, owner?.ownerUserId ?? null, today, addDays(today, 180), timeZone, input.now.getTime());
  const opaqueDates = new Set<LocalDate>(privateBusy.opaqueDates);
  if ((googleCoverage.enabled || mirrored?.enabled) && !exactMirror) {
    const known = new Map(googleCoverage.days.map(day => [day.local_date, day]));
    for (let date = today; date <= addDays(today, 180); date = addDays(date, 1)) {
      const value = known.get(date); const stamp = Date.parse(value?.fetched_at ?? '');
      if (mirrored?.enabled || !value || value.time_zone !== timeZone || !Number.isFinite(stamp) || stamp > input.now.getTime()
        || input.now.getTime() - stamp > CALENDAR_AVAILABILITY_MAX_AGE_MS || value.busy_minutes !== 0) opaqueDates.add(date);
    }
  }
  let geometry: ReturnType<typeof prepareAdaptivePlacementInput> | undefined;
  return { householdId: input.householdId, ownerId, today, now, clothingRegion, mode: settings.frequency_mode, chores, states, fixedLoads, seasonalPendingRoundIds,
    assignedMemberIds: id => assignments.get(id) ?? [], fingerprint: adaptivePersonalDigest,
    suppressedChoreIds: shared.suppressedPersonalChoreIds,
    assertInputsCurrent: async () => { owner?.assertCurrent(); await input.assertInputsCurrent?.(); owner?.assertCurrent(); },
    sourceRevision: personalAdaptiveSourceRevision({ mode: settings.frequency_mode, timeZone, preferences,
      calendarTiming: [adaptiveCalendarTiming(calendarInput.events, calendarInput.exceptions), privateBusy.busy, [...opaqueDates], Boolean(sharedCalendar?.conflicted),
        weather ? [municipality?.id, weather.forecast.intervals] : null], sharedLoads: [owner?.ownerUserId ?? null, shared.loads, [...shared.suppressedPersonalChoreIds].sort()] }, adaptivePersonalDigest),
    prepareGeometry() {
      if (geometry) return geometry;
      geometry = prepareAdaptivePlacementInput({ from: today, through: addDays(today, 180), timeZone,
        preferences, ...calendarInput, busy: privateBusy.busy, ...(weatherCacheFreshness(weather, input.now.getTime()).placement ? { weatherForecast: weather!.forecast } : {}),
        fingerprint: adaptivePersonalDigest });
      if (opaqueDates.size) {
        const opaque = geometry.days.filter(day => opaqueDates.has(day.date));
        // The old FreeBusy cache deliberately retained daily totals only. Such
        // a total cannot be placed at a guessed hour or combined using max().
        // Until exact events are available, reserve that opaque day, leaving
        // the chore's date-only fallback rather than claiming a free slot.
        geometry = { ...geometry, busy: unionInstantSpans([...geometry.busy, ...opaque.map(day => day.bounds)]),
          revision: adaptivePersonalDigest([geometry.revision, opaque.map(day => day.date)]) };
      }
      if (sharedCalendar?.unbounded) geometry = { ...geometry, busy: unionInstantSpans([...geometry.busy, ...geometry.days.map(day => day.bounds)]),
        revision: adaptivePersonalDigest([geometry.revision, 'shared-calendar-unresolved']) };
      return geometry;
    },
  };
}
