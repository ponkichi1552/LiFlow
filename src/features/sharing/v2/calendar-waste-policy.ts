import type { LocalDate } from '../../../domain/shared/types.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { WeeklyWasteSchedule } from '../../waste/contracts';
import { generateWasteCollectionDates } from '../../waste/weekly-scheduler.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { SharedOperation } from '../operations.ts';
import type { V2HistoryView } from './history-view.ts';
import { readV2EditableField } from './field-edit.ts';
import { readV2WasteVisibility, v2WasteVisibilityId } from './waste-state.ts';
import type { V2WasteOccurrence, V2WasteRow } from './waste-state';

export interface V2WasteCalendarPolicy {
  complete: boolean;
  groupId: string;
  exceptions: { key: string; hidden: boolean | null; revision: string }[];
}

/** Build a display-only index from already authenticated shared facts. */
export function buildV2WasteCalendarPolicy(view: V2HistoryView, at: SharedOperation, rows: readonly V2WasteRow[], trusted: boolean): V2WasteCalendarPolicy {
  let complete = trusted && rows.every(row => row.deleted || !row.needsReview);
  const visibilityEntities = new Map<string, SharedOperation[]>();
  for (const operation of view.observed(view.ofType('wasteVisibility'), at)) {
    const operations = visibilityEntities.get(operation.entityId) ?? [];
    operations.push(operation); visibilityEntities.set(operation.entityId, operations);
  }

  const exceptions = new Map<string, V2WasteCalendarPolicy['exceptions'][number]>();
  for (const [entityId, operations] of visibilityEntities) {
    const candidates = new Map<string, { scheduleId: string; date: LocalDate }>();
    for (const operation of operations) {
      const scheduleId = operation.payload.scheduleId;
      const date = operation.payload.date;
      if (typeof scheduleId !== 'string' || typeof date !== 'string') continue;
      try {
        const localDate = date as LocalDate; parseLocalDate(localDate);
        if (v2WasteVisibilityId(scheduleId, localDate) !== entityId) { complete = false; continue; }
        candidates.set(`${scheduleId}:${date}`, { scheduleId, date: localDate });
      } catch { complete = false; }
    }
    if (!candidates.size) { complete = false; continue; }

    for (const candidate of candidates.values()) {
      const scheduleField = readV2EditableField(view, at, 'wasteVisibility', entityId, 'scheduleId');
      const dateField = readV2EditableField(view, at, 'wasteVisibility', entityId, 'date');
      if (scheduleField.kind !== 'value' || scheduleField.value !== candidate.scheduleId
        || dateField.kind !== 'value' || dateField.value !== candidate.date) { complete = false; continue; }
      const state = readV2WasteVisibility(view, at, candidate.scheduleId, candidate.date);
      exceptions.set(`${candidate.scheduleId}:${candidate.date}`, { key: `${candidate.scheduleId}:${candidate.date}`, hidden: state.hidden, revision: state.revision });
    }
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return { complete, groupId: view.groupId, exceptions: [...exceptions.values()].sort((a, b) => compare(a.key, b.key)) };
}

/** Prepare reusable lookup maps, then project only a requested slice without extending chore generation. */
export function createV2WasteCalendarProjector(policy: V2WasteCalendarPolicy, rows: readonly V2WasteRow[], schedules: readonly WeeklyWasteSchedule[]) {
  const revisions = new Map(rows.map(row => [row.id, row.revision]));
  const visibility = new Map(policy.exceptions.map(entry => [entry.key, entry]));
  return (from: LocalDate, through: LocalDate): V2WasteOccurrence[] => {
    if (!policy.complete) return [];
    const occurrences = schedules.flatMap(schedule => generateWasteCollectionDates(schedule, from, through).map(occurrence => {
      const key = `${schedule.id}:${occurrence.date}`;
      const exception = visibility.get(key);
      const visibilityRevision = exception?.revision ?? sharedDocumentDigest([policy.groupId, v2WasteVisibilityId(schedule.id, occurrence.date), [], [], [], []]);
      return { key, occurrence, hidden: exception ? exception.hidden : false, selection: { groupId: policy.groupId, scheduleId: schedule.id, date: occurrence.date,
        scheduleRevision: revisions.get(schedule.id) ?? '', visibilityRevision } };
    })).sort((a, b) => a.occurrence.date < b.occurrence.date ? -1 : a.occurrence.date > b.occurrence.date ? 1
      : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return occurrences;
  };
}

export function projectV2WasteCalendar(policy: V2WasteCalendarPolicy, rows: readonly V2WasteRow[], schedules: readonly WeeklyWasteSchedule[], from: LocalDate, through: LocalDate): V2WasteOccurrence[] {
  return createV2WasteCalendarProjector(policy, rows, schedules)(from, through);
}
