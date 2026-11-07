import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '../../../domain/chores/types';
import type { LocalDate } from '../../../domain/shared/types';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { completionIncludesDate, completionMatchesEntry, completionPeriod, completionRecordedDate } from '../../../domain/scheduling/completion-matching.ts';
import { orderDateTasks, selectDateTasks, createDateTaskSelector } from '../../../domain/scheduling/date-tasks.ts';
import { calendarPendingCountsByDate } from '../../../domain/calendar/day-entries.ts';
import { dateTaskRevision } from '../../../domain/scheduling/date-task-reference.ts';
import type { PersonalDateTaskCommand } from '../../../domain/scheduling/date-task-reference';
import type { PlannerSnapshot } from '../../../platform/storage/repository';
import type { V2PersonalDayLoad } from '../v2/personal-plan';
import { commonChoreLinks } from '../../planner/common-chore-links.ts';
import type { CommonCompletionSource } from '../../planner/common-chore-links';
import type { CapturedSharedPlanning } from '../../planner/shared-adaptive-load';
import { personalLongCalendarPreviews } from '../../calendar/long-cycle-preview.ts';

export interface V2PrivateTaskRow {
  source: 'personal'; key: string; revision: string; ownerUserId: string; householdId: string;
  date: LocalDate; graceDays: 0 | 3; chore: ChoreDefinition; completed: boolean; completedDate?: LocalDate; suggestedDate: LocalDate; windowStart?: LocalDate; windowEnd?: LocalDate;
  seasonalWork?: ChoreScheduleEntry['seasonalWork'];
  provisional?: boolean; calendarNext?: boolean;
}
export interface V2PrivateOverlay {
  status: 'ready'; ownerUserId: string; householdId: string; timeZone: string; today: LocalDate; setupCompleted: boolean;
  range: { from: LocalDate; through: LocalDate }; generatedThrough: LocalDate;
  home: V2PrivateTaskRow[]; byDate: Map<LocalDate, V2PrivateTaskRow[]>; counts: Map<LocalDate, number>;
  dailyLoad: Partial<Record<LocalDate, V2PersonalDayLoad>>;
  sharedPlanning?: CapturedSharedPlanning;
  calendarLongDates?: LocalDate[];
  calendarLongRows?: V2PrivateTaskRow[];
}
export type V2PrivateOverlayState = V2PrivateOverlay | { status: 'unavailable'; message: string };
export interface V2PrivateTaskSource {
  read(range: { from: LocalDate; through: LocalDate }, instant: Date, commonChores?: CommonCompletionSource['chores']): Promise<V2PrivateOverlay>;
  setCompleted(key: string, revision: string, completed: boolean): Promise<boolean>;
  mirrorShared?(source: CommonCompletionSource): Promise<void>;
}
export interface PrivatePlannerInput { ownerUserId: string; today: LocalDate; timeZone: string; snapshot: PlannerSnapshot }

/** UI-only composition. The returned rows are never accepted as shared events or shared scheduler input. */
export function projectV2PrivateTasks(input: PrivatePlannerInput, ownerUserId: string, range: { from: LocalDate; through: LocalDate }): V2PrivateOverlay {
  const { snapshot, today, timeZone } = input;
  if (!ownerUserId || input.ownerUserId !== ownerUserId || snapshot.sharing || snapshot.household.id !== 'local-household') {
    throw new Error('本人の個人家事を確認してください。');
  }
  parseLocalDate(today); parseLocalDate(range.from); parseLocalDate(range.through);
  if (range.from > range.through || addDays(range.from, 366) < range.through) throw new Error('個人家事を表示する期間を確認してください。');
  new Intl.DateTimeFormat('en', { timeZone }).format(0);
  const chores = snapshot.chores.filter((chore) => chore.enabled && !chore.archived);
  const buckets = new Map(chores.map((chore) => [chore.id, { chore, entries: [] as ChoreScheduleEntry[], completions: [] as ChoreCompletion[] }]));
  for (const row of [...snapshot.chores, ...snapshot.scheduleEntries, ...snapshot.completions]) {
    if (row.householdId !== snapshot.household.id) throw new Error('個人の保存先が変わっています。');
  }
  for (const entry of snapshot.scheduleEntries) buckets.get(entry.choreId)?.entries.push(entry);
  for (const completion of snapshot.completions) buckets.get(completion.choreId)?.completions.push(completion);
  const home: V2PrivateTaskRow[] = []; const byDate = new Map<LocalDate, V2PrivateTaskRow[]>(); const counts = new Map<LocalDate, number>();
  const dailyLoad: V2PrivateOverlay['dailyLoad'] = {};
  if (snapshot.settings.setupCompleted) for (const { chore, entries, completions } of buckets.values()) {
    const from = range.from < today ? range.from : today; const through = range.through > today ? range.through : today;
    // Keep the original selector and completion ordering. Index once so each calendar cell need not scan unrelated history.
    const firstByEntry = new Map<string, ChoreCompletion>(); const legacy: ChoreCompletion[] = [];
    const needed = new Set<ChoreCompletion>();
    for (const completion of completions) {
      if (completion.outcome !== 'completed') continue;
      if (completion.scheduleEntryId) { if (!firstByEntry.has(completion.scheduleEntryId)) firstByEntry.set(completion.scheduleEntryId, completion); }
      else legacy.push(completion);
      const period = completionPeriod(completion);
      const recordedDate = completionRecordedDate(completion);
      if (period.start <= through && period.end >= from || completionIncludesDate(completion, today)
        || recordedDate >= from && recordedDate <= through) needed.add(completion);
    }
    for (const entry of entries) {
      const completion = firstByEntry.get(entry.id) ?? legacy.find((candidate) => completionMatchesEntry(candidate, entry));
      if (completion) needed.add(completion);
    }
    const relevant = completions.filter((completion) => needed.has(completion));
    const select = createDateTaskSelector(entries, relevant, [chore]);
    const rows = (date: LocalDate, graceDays: 0 | 3) => select(date, graceDays, graceDays === 3).map((task): V2PrivateTaskRow => ({
      source: 'personal', key: `personal:${JSON.stringify([ownerUserId, snapshot.household.id, date, graceDays, chore.id,
        ...((task.entry?.seasonalWork ?? task.completion?.seasonalWork) ? [task.entry?.seasonalWork ?? task.completion?.seasonalWork] : [])])}`,
      revision: dateTaskRevision(task), ownerUserId, householdId: snapshot.household.id, date, graceDays, chore,
      seasonalWork: task.entry?.seasonalWork ?? task.completion?.seasonalWork,
      completed: task.completed, completedDate: task.completion ? completionRecordedDate(task.completion) : undefined, suggestedDate: task.suggestedDate, windowStart: task.entry?.windowStart ?? task.completion?.scheduledWindowStart, windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd,
    }));
    home.push(...rows(today, 3));
    for (let date = range.from; date <= range.through; date = addDays(date, 1)) {
      const selected = rows(date, date === today ? 3 : 0); if (selected.length) byDate.set(date, [...(byDate.get(date) ?? []), ...selected]);
    }
    for (const [date, count] of calendarPendingCountsByDate(entries, relevant)) {
      if (date < range.from || date > range.through) continue;
      const day = dailyLoad[date] ?? { heavy: 0, normal: 0, total: 0 }; day.total += count;
      if (chore.load !== 'light') day[chore.load] += count; dailyLoad[date] = day;
    }
  }
  const calendarLongDates: LocalDate[] = []; const calendarLongRows: V2PrivateTaskRow[] = [];
  if (snapshot.settings.setupCompleted) for (const preview of personalLongCalendarPreviews(snapshot, today)) {
    const date = preview.entry.suggestedDate;
    const [task] = selectDateTasks([preview.entry], preview.provisional ? [] : snapshot.completions, date, 0, [preview.chore]);
    if (!task) continue;
    calendarLongDates.push(date);
    const existing = byDate.get(date)?.find(row => row.chore.id === preview.chore.id && !preview.provisional && row.revision === dateTaskRevision(task));
    if (existing) calendarLongRows.push({ ...existing, calendarNext: true });
    else calendarLongRows.push({ source: 'personal', key: `personal:${JSON.stringify([ownerUserId, snapshot.household.id, date, 0, preview.chore.id])}`,
      revision: preview.provisional ? '' : dateTaskRevision(task), ownerUserId, householdId: snapshot.household.id,
      date, graceDays: 0, chore: preview.chore, completed: false, suggestedDate: date, windowStart: preview.entry.windowStart, windowEnd: preview.entry.windowEnd,
      provisional: preview.provisional, calendarNext: true });
  }
  const order = (rows: V2PrivateTaskRow[], date: LocalDate) => {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return orderDateTasks(rows.map((row) => ({ id: row.key, choreId: row.chore.id, suggestedDate: row.suggestedDate, completed: row.completed })), date, chores)
      .map((task) => byKey.get(task.id)!);
  };
  for (const [date, rows] of byDate) { byDate.set(date, order(rows, date)); counts.set(date, rows.filter(row => !row.completed).length); }
  return { status: 'ready', ownerUserId, householdId: snapshot.household.id, today, timeZone, range: { ...range },
    ...(snapshot.personalSharedPlanning?.ownerUserId === ownerUserId ? { sharedPlanning: snapshot.personalSharedPlanning } : {}),
    generatedThrough: addDays(today, 180), setupCompleted: snapshot.settings.setupCompleted, home: order(home, today), byDate, counts, dailyLoad, calendarLongDates, calendarLongRows };
}

/** Display counts use the same execution-period rows as home and the selected day. */
export function privateOverlayCalendarRows(rows: readonly V2PrivateTaskRow[], date: LocalDate) {
  return rows.filter(row => (row.completedDate ?? row.suggestedDate) === date);
}
export function privateOverlayPendingCounts(overlay: V2PrivateOverlay | undefined, values?: ReadonlyMap<string, boolean>, recommendedOnly = false) {
  const counts = new Map<LocalDate, number>();
  if (overlay) for (const [date, rows] of overlay.byDate) counts.set(date, (recommendedOnly ? privateOverlayCalendarRows(rows, date) : rows).filter(row => !(values?.get(row.key) ?? row.completed)).length);
  return counts;
}

export function privateOverlayForViewer(value: V2PrivateOverlayState | undefined, viewerUserId: string): V2PrivateOverlayState | undefined {
  if (value?.status === 'ready' && value.ownerUserId !== viewerUserId) throw new Error('本人以外の個人家事は表示できません。');
  return value;
}

/** Captured commands contain only references selected from the personal source. A caller cannot inject an entry. */
export function createV2PrivateTaskSource(input: { ownerUserId: string; assertAccess: () => void | Promise<void>;
  readSnapshot: (instant: Date) => Promise<PrivatePlannerInput>;
  save: (command: PersonalDateTaskCommand, assertAccess: () => void | Promise<void>) => Promise<boolean>;
  afterChange?: () => void | Promise<void>;
  mirrorShared?: (source: CommonCompletionSource, assertAccess: () => void | Promise<void>) => Promise<number>;
}): V2PrivateTaskSource {
  let reading = 0; let selected = new Map<string, PersonalDateTaskCommand>(); const pending = new Set<string>();
  return {
    async mirrorShared(source) {
      if (!input.mirrorShared) return;
      await input.assertAccess();
      if (await input.mirrorShared(source, input.assertAccess)) await input.afterChange?.();
    },
    async read(range, instant, commonChores) {
      const generation = ++reading; await input.assertAccess();
      const data = await input.readSnapshot(instant);
      const common = new Set(commonChoreLinks(data.snapshot.chores, commonChores ?? []).map(link => link.personalChoreId));
      const value = projectV2PrivateTasks({ ...data, snapshot: { ...data.snapshot, chores: data.snapshot.chores.filter(chore => !common.has(chore.id)) } }, input.ownerUserId, range);
      await input.assertAccess();
      if (generation === reading) {
        for (const row of [...value.home, ...[...value.byDate.values()].flat(), ...value.calendarLongRows ?? []]) {
          if (row.provisional) continue;
          selected.delete(row.key); selected.set(row.key, { date: row.date, graceDays: row.graceDays, choreId: row.chore.id, revision: row.revision, completed: row.completed });
        }
        // Cached visible months can still issue their exact, CAS-checked command after a different month is read.
        while (selected.size > 25_000) selected.delete(selected.keys().next().value!);
      }
      return value;
    },
    async setCompleted(key, revision, completed) {
      if (pending.has(key)) return false;
      const displayed = selected.get(key);
      if (!displayed || displayed.revision !== revision || typeof completed !== 'boolean') throw new Error('表示した個人家事を選び直してください。');
      if (displayed.completed === completed) return false;
      pending.add(key);
      try {
        await input.assertAccess(); const changed = await input.save({ ...displayed, completed }, input.assertAccess);
        if (changed) { selected.delete(key); await input.afterChange?.(); } return changed;
      } finally { pending.delete(key); }
    },
  };
}
