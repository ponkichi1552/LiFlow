import { openDatabaseAsync } from 'expo-sqlite';
import { readPersonalPlannerOverlaySnapshot } from '../storage/repository';
import { openPrivateCalendarRuntime } from './private-calendar-runtime';
import { v2OwnerScheduleSettings } from '../../features/sharing/v2-ui/owner-preferences';
import { createV2PrivateTaskSource, projectV2PrivateTasks } from '../../features/sharing/v2-ui/private-overlay';
import { buildV2PersonalPlan } from '../../features/sharing/v2/personal-plan';
import type { V2CommonPlan } from '../../features/sharing/v2/common-plan';
import { sharedDocumentDigest } from '../../features/sharing/crypto';
import { readLocalCalendar } from '../storage/calendar-events';
import { createLocalCalendarAvailability, createLocalCalendarPlanSource } from '../../features/calendar/private-availability';
import { sharedCalendarAvailability } from '../../features/calendar/shared-events';
import type { SharedCalendarRecord } from '../../features/sharing/v2/calendar-state';
import { combinePrivateCalendarAvailability } from '../../features/sharing/v2/private-availability';
import { usesPersonalAdaptivePlanner } from '../../domain/chores/personal-catalog';
import { capturedSharedRecommendations } from '../../features/planner/shared-adaptive-load';
import { readPlanningInputRevision } from '../storage/planning-input-revision';

/** Both native integrations use the same owner-only inputs. Rendering/planning never fetches Google or requests a grant. */
export async function readV2LocalPlanning(input: { userId: string; assertAccess(): void | Promise<void> }, now: Date) {
  await input.assertAccess(); const personal = await openDatabaseAsync('housework.db', { useNewConnection: true });
  let dispose = () => {};
  try {
    const calendar = openPrivateCalendarRuntime(input.userId); let invalidated = false;
    const stop = calendar.subscribe(() => { invalidated = true; });
    const stopPreferences = calendar.plannerSync?.store.subscribe(() => { invalidated = true; });
    dispose = () => { stop(); stopPreferences?.(); };
    await input.assertAccess(); const snapshot = await readPersonalPlannerOverlaySnapshot(personal, now); await input.assertAccess();
    const before = await readPlanningInputRevision(personal);
    if (snapshot.snapshot.planningInputRevision !== undefined && snapshot.snapshot.planningInputRevision !== before) throw new Error('本人の予定が更新されました。読み直してください。');
    const own = await calendar.readPlannerPreferences(); await input.assertAccess();
    const preferences = v2OwnerScheduleSettings(input.userId, snapshot.snapshot.settings, own);
    // An unavailable cache remains unknown; the personal planner applies its normal freshness and coverage rules.
    const busy = await calendar.readForPlan().catch(() => null); await input.assertAccess();
    const localEvents = await readLocalCalendar(personal); await input.assertAccess();
    const capturedRevision = await readPlanningInputRevision(personal);
    if (invalidated || capturedRevision !== before) throw new Error('本人の予定が更新されました。読み直してください。');
    const localCalendar = createLocalCalendarPlanSource({ ownerUserId: input.userId, assertAccess: input.assertAccess, read: async () => localEvents });
    if (busy && (busy.ownerUserId !== input.userId || busy.cache.ownerUserId !== input.userId || busy.binding.ownerUserId !== input.userId)) throw new Error('本人のCalendar情報を確認してください。');
    const source = { ...snapshot, ownerUserId: input.userId };
    const privateTasks = createV2PrivateTaskSource({ ownerUserId: input.userId, assertAccess: input.assertAccess,
      readSnapshot: async () => source, save: async () => { throw new Error('連携の予定計算から個人家事は変更できません。'); } });
    const calendarRows = [...localEvents.events.map(row => [row.id, row.revision]), ...localEvents.exceptions.map(row => [row.eventId, row.anchorDate, row.revision])];
    const calendarPages = []; for (let offset = 0; offset < calendarRows.length; offset += 500) calendarPages.push(sharedDocumentDigest(calendarRows.slice(offset, offset + 500)));
    const revision = sharedDocumentDigest(JSON.stringify([preferences, snapshot.timeZone, snapshot.snapshot.scheduleEntries, snapshot.snapshot.completions,
      snapshot.snapshot.chores.map(chore => [chore.id, chore.enabled, Boolean(chore.archived), chore.load]), busy, calendarPages]));
    return { revision, preferences, privateTasks, localCalendar, calendar: { readForPlan: async () => busy, readOwnCalendar: calendar.readOwnCalendar }, dispose,
      async assertCurrent() {
        await input.assertAccess(); if (invalidated) throw new Error('本人の予定が更新されました。読み直してください。');
        const connection = await openDatabaseAsync('housework.db', { useNewConnection: true });
        try { if (await readPlanningInputRevision(connection) !== capturedRevision) throw new Error('本人の予定が更新されました。読み直してください。'); }
        finally { await connection.closeAsync(); }
        await input.assertAccess(); if (invalidated) throw new Error('本人の予定が更新されました。読み直してください。');
      },
      personalize(plan: V2CommonPlan, sharedEvents: readonly SharedCalendarRecord[] = []) {
        const overlay = projectV2PrivateTasks(source, input.userId, plan.range);
        return capturedSharedRecommendations(plan, buildV2PersonalPlan(plan, { viewerUserId: input.userId, now: now.getTime(), settings: preferences.settings,
          localCalendar: { ownerUserId: input.userId, availability: combinePrivateCalendarAvailability(
            createLocalCalendarAvailability(localEvents.events, localEvents.exceptions, plan.range, plan.timeZone),
            sharedCalendarAvailability(sharedEvents, plan.groupId, plan.range, plan.timeZone)) },
          ...(!source.snapshot.chores.some(usesPersonalAdaptivePlanner) && overlay.timeZone === plan.timeZone ? { privateLoad: { ownerUserId: input.userId, days: overlay.dailyLoad } } : {}),
          ...(busy ? { calendar: { cache: busy.cache, binding: busy.binding } } : {}) }), source.snapshot.personalSharedPlanning);
      },
    };
  } catch (error) { dispose(); throw error; } finally { await personal.closeAsync(); }
}
