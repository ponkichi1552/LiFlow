import type { SQLiteDatabase } from 'expo-sqlite';
import { createV2ReminderStore } from '../storage/sharing-v2-reminders';
import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';
import { createV2ReminderRuntime } from '../../features/sharing/v2/reminder-runtime';
import type { V2GroupController } from '../../features/sharing/v2/controller';
import { createV2ScreenSession } from '../../features/sharing/v2-ui/screen-session';
import { readV2LocalPlanning } from './v2-local-planning';
import { reconcileLocalNotifications } from '../../features/notifications/reconcile-local-notifications';
import { v2NotificationPrefix } from '../../features/sharing/v2/native-identity';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createNativeV2CompletionNotices } from './v2-completion-notices';
import { v2CompletionNoticePrefix } from '../../features/sharing/v2/completion-notices';
import { v2LoadNoticePrefix } from '../../features/sharing/v2/load-notice-runtime';
import { createNativeV2LoadNotices } from './v2-load-notices';
import { clearV2ImmediateNotices } from './v2-immediate-notices';

/** Local v2 projection only; never register a legacy planner adapter or acquire OAuth here. */
export function createNativeV2Reminders(input: { database: SQLiteDatabase; userId: string; groupId: string;
  repository: ReturnType<typeof createV2EventRepository>; controller: V2GroupController; assertAccess(): void | Promise<void> }) {
  const store = createV2ReminderStore(input.database, input);
  const notices = createNativeV2CompletionNotices(input);
  const readModel = async (now: Date) => {
        const local = await readV2LocalPlanning(input, now);
        const session = createV2ScreenSession({ controller: input.controller, userId: input.userId, groupId: input.groupId, now: () => now,
          readPreferences: () => local.preferences, privateTasks: local.privateTasks, calendar: local.calendar, localCalendar: local.localCalendar });
        const model = await session.readModel({ reminders: true }); await input.assertAccess(); return model;
    };
  const loads = createNativeV2LoadNotices({ ...input, readControl: store.read, readCurrent: async () => {
    const model = await readModel(new Date()); await input.assertAccess(); return { assessment: model.dailyLoad, control: await store.read() };
  } });
  return createV2ReminderRuntime({ ...input, store, gateway: expoLocalNotificationGateway, readModel,
    afterSynchronize: async (remaining, model, control) => {
      const deadline = Date.now() + remaining;
      const failures: unknown[] = [];
      try { await loads.synchronize(model?.dailyLoad, control, Math.max(1, deadline - Date.now())); } catch (error) { failures.push(error); }
      const rest = deadline - Date.now();
      if (rest > 0) try { await notices.synchronize(rest); } catch (error) { failures.push(error); }
      if (failures.length) throw failures[0];
    } });
}

/** A previous account/removed group may cancel its own reminders without reading group data. */
export async function clearInactiveV2Reminders(allowed: readonly { userId: string; groupId: string }[], assertCurrent: () => void | Promise<void> = () => {}) {
  await assertCurrent();
  const keep = new Set(allowed.map(scope => v2NotificationPrefix(scope.userId, scope.groupId)));
  const scheduled = await expoLocalNotificationGateway.getScheduledRequests();
  await assertCurrent();
  const prefixes = new Set(scheduled.flatMap(request => {
    const match = /^liflow-v2-digest:[a-f0-9]{64}:/u.exec(request.key); return match && !keep.has(match[0]) ? [match[0]] : [];
  }));
  const failures: unknown[] = [];
  for (const prefix of prefixes) try { await reconcileLocalNotifications(expoLocalNotificationGateway, { prefix, enabled: false, desired: [], assertCurrent }); }
  catch (error) { failures.push(error); }
  const immediateKeep = new Set(allowed.flatMap(scope => [v2CompletionNoticePrefix(scope.userId, scope.groupId), v2LoadNoticePrefix(scope.userId, scope.groupId)]));
  try { await clearV2ImmediateNotices(id => { const match = /^liflow-v2-(?:completed|load):[a-f0-9]{64}:/u.exec(id)?.[0]; return Boolean(match && !immediateKeep.has(match)); }, assertCurrent); } catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
}
export async function clearV2RemindersForScope(userId: string, groupId: string) {
  const results = await Promise.allSettled([reconcileLocalNotifications(expoLocalNotificationGateway, { prefix: v2NotificationPrefix(userId, groupId), enabled: false, desired: [] }),
    clearV2ImmediateNotices(id => id.startsWith(v2CompletionNoticePrefix(userId, groupId)) || id.startsWith(v2LoadNoticePrefix(userId, groupId)), () => {})]);
  const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
}
