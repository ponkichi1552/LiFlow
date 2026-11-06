import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry, HouseholdPlannerSettings } from '@/domain/chores/types';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import { addDays, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import type { LocalNotificationGateway, LocalNotificationRequest } from '@/features/notifications/contracts';
import { sharedDateAtTime, sharedLocalDate } from '../sharing/group-clock';
import { reconcileLocalNotifications } from './reconcile-local-notifications';
import type { NotificationReconciliationResult } from './reconcile-local-notifications';
import { choreOccurrenceName } from '../../domain/chores/occurrence-name';

const DAILY_DIGEST_KEY_PREFIX = 'housework-digest:';
const SCHEDULE_HORIZON_DAYS = 30;

export interface DailyDigestSnapshot {
  timeZone?: string;
  notificationScope?: string;
  notificationTitle?: string;
  scheduleEntries: readonly ChoreScheduleEntry[];
  chores: readonly (Pick<ChoreDefinition, 'id' | 'name'> & Partial<Pick<ChoreDefinition, 'enabled' | 'archived'>>)[];
  completions: readonly ChoreCompletion[];
  settings: Pick<HouseholdPlannerSettings, 'notificationHour' | 'notificationMinute' | 'notificationsEnabled' | 'setupCompleted'>;
}

export function createDailyHouseworkDigestRequests(
  snapshot: DailyDigestSnapshot,
  now = new Date(),
): LocalNotificationRequest[] {
  const today = snapshot.timeZone ? sharedLocalDate(now, snapshot.timeZone) : localDateFromDate(now);
  const prefix = notificationPrefix(snapshot);
  const requests: LocalNotificationRequest[] = [];
  const through = addDays(today, SCHEDULE_HORIZON_DAYS);
  const entriesByDate = new Map<LocalDate, ChoreScheduleEntry[]>();
  const choresById = new Map(snapshot.chores.map(chore => [chore.id, chore]));
  const completionsByChore = new Map<string, ChoreCompletion[]>();
  for (const completion of snapshot.completions) {
    const bucket = completionsByChore.get(completion.choreId);
    if (bucket) bucket.push(completion); else completionsByChore.set(completion.choreId, [completion]);
  }
  // Only the three reminder boundaries matter. Long windows and old history do
  // not require a full planner scan for every future notification date.
  for (const entry of snapshot.scheduleEntries) for (const date of new Set([entry.windowStart, entry.windowEnd, addDays(entry.windowEnd, 1)])) {
    if (date < today || date > through) continue;
    const bucket = entriesByDate.get(date);
    if (bucket) bucket.push(entry); else entriesByDate.set(date, [entry]);
  }

  for (let offset = 0; offset <= SCHEDULE_HORIZON_DAYS; offset += 1) {
    const date = addDays(today, offset);
    const fireAt = snapshot.timeZone ? sharedDateAtTime(date, snapshot.settings.notificationHour, snapshot.settings.notificationMinute, snapshot.timeZone)
      : localDateAtTime(date, snapshot.settings.notificationHour, snapshot.settings.notificationMinute);
    if (fireAt <= now) continue;

    const entries = entriesByDate.get(date) ?? [];
    const choreIds = [...new Set(entries.map(entry => entry.choreId))];
    const completions = choreIds.flatMap(id => completionsByChore.get(id) ?? []);
    const chores = choreIds.flatMap(id => choresById.get(id) ?? []);
    const dueEntries = selectDateTasks(entries, completions, date, 1, chores)
      .filter((task) => !task.completed)
      .sort((left, right) => urgency(left.entry!.status) - urgency(right.entry!.status)
        || left.suggestedDate.localeCompare(right.suggestedDate));
    const names = dueEntries
      .map((entry) => {
        const chore = choresById.get(entry.choreId);
        return chore ? choreOccurrenceName(chore.name, entry.entry?.seasonalWork ?? entry.completion?.seasonalWork) : undefined;
      })
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) continue;

    const visibleNames = names.slice(0, 4).join('、');
    const remaining = names.length - Math.min(names.length, 4);
    requests.push({
      key: `${prefix}${date}`,
      title: snapshot.notificationTitle ?? '今日の家事',
      subtitle: `${names.length}件の未完了タスク`,
      body: `${visibleNames}${remaining > 0 ? `、ほか${remaining}件` : ''}`,
      fireAt: fireAt.toISOString() as LocalNotificationRequest['fireAt'],
      data: { kind: 'daily-housework-digest', date, ...(snapshot.notificationScope ? { workspace: snapshot.notificationScope } : {}) },
    });
  }

  return requests;
}

export async function syncDailyHouseworkDigest(
  gateway: LocalNotificationGateway,
  snapshot: DailyDigestSnapshot,
  now?: Date,
): Promise<NotificationReconciliationResult> {
  const enabled = snapshot.settings.notificationsEnabled && snapshot.settings.setupCompleted;
  return reconcileLocalNotifications(gateway, { prefix: notificationPrefix(snapshot), enabled,
    desired: enabled ? createDailyHouseworkDigestRequests(snapshot, now ?? new Date()) : [] });
}

function notificationPrefix(snapshot: DailyDigestSnapshot): string {
  if (!snapshot.notificationScope) return DAILY_DIGEST_KEY_PREFIX;
  if (!/^[a-f0-9]{64}$/u.test(snapshot.notificationScope)) throw new Error('Invalid notification workspace');
  return `liflow-group-digest:${snapshot.notificationScope}:`;
}

function localDateAtTime(date: LocalDate, hour: number, minute: number): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function urgency(status: ChoreScheduleEntry['status']): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}
