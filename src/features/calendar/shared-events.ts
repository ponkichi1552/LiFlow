import type { CalendarCategory, CalendarEvent, CalendarException } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import { sharedCalendarPayload } from '../sharing/v2/calendar-state.ts';
import type { SharedCalendarRecord } from '../sharing/v2/calendar-state';
import type { PrivateCalendarAvailability } from '../sharing/v2/private-availability';
import { createLocalCalendarAvailability } from './private-availability.ts';

/** One projection for displayed events, recommendation inputs and native integrations. */
export function projectSharedCalendarRecords(records: readonly SharedCalendarRecord[], groupId: string) {
  const eventId = (id: string) => `group.${sharedDocumentDigest([groupId, id])}`;
  const identified = records.map(record => ({ record, id: eventId(record.id) }));
  const recordsById = new Map(identified.map(({ record, id }) => [id, record]));
  const groupCategories = new Map<string, CalendarCategory>(); const rawCategories = new Map<string, CalendarCategory>();
  const categoryIds = new Map<string, string>();
  const events: CalendarEvent[] = []; const exceptions: CalendarException[] = [];
  let conflicted = false;
  for (const { record, id } of identified) {
    if (record.heads.length !== 1) { conflicted = true; continue; }
    const payload = sharedCalendarPayload(record.heads[0]); if (!payload.value || !payload.category) continue;
    const category = (value: NonNullable<typeof payload.category>) => {
      const key = JSON.stringify([value.id, value.name, value.color]); const existing = categoryIds.get(key);
      if (existing) return existing;
      const result = { ...value, id: `gcat.${sharedDocumentDigest([groupId, value])}`, revision: 1 };
      groupCategories.set(result.id, result); rawCategories.set(result.id, { ...value, revision: 1 }); categoryIds.set(key, result.id); return result.id;
    };
    events.push({ ...payload.value, categoryId: category(payload.category), id, revision: record.heads[0].logicalClock });
    for (const row of record.exceptions) {
      const candidate = row.heads.length === 1 ? sharedCalendarPayload(row.heads[0]) : null;
      if (!candidate) conflicted = true;
      exceptions.push({ eventId: id, anchorDate: row.anchorDate, revision: Math.max(...row.heads.map(op => op.logicalClock)),
        override: candidate?.value && candidate.category ? { ...candidate.value, categoryId: category(candidate.category) } : null });
    }
  }
  return { recordsById, groupCategories, rawCategories, events, exceptions, conflicted };
}

/** Private placement reserves the union of every signed candidate. This does
 * not resolve the shared conflict or publish any candidate as the formal event. */
export function projectSharedCalendarPlanningRecords(records: readonly SharedCalendarRecord[], groupId: string) {
  const normal = projectSharedCalendarRecords(records, groupId);
  if (!normal.conflicted) return { ...normal, unbounded: false };
  const alternatives: SharedCalendarRecord[] = []; const exceptionEvents: CalendarEvent[] = [];
  let unbounded = false;
  for (const record of records) {
    if (!record.heads.length) { unbounded = true; continue; }
    if (record.heads.length > 1) for (const head of record.heads) alternatives.push({ ...record,
      id: `candidate.${sharedDocumentDigest([record.id, head.operationId])}`, heads: [head] });
    if (!record.heads.some(head => sharedCalendarPayload(head).value !== null)) continue;
    for (const row of record.exceptions) if (row.heads.length !== 1) {
      if (!row.heads.length) { unbounded = true; continue; }
      for (const head of row.heads) {
        const payload = sharedCalendarPayload(head);
        if (payload.value) exceptionEvents.push({ ...payload.value, recurrence: 'none', untilDate: null,
          id: `candidate.${sharedDocumentDigest([groupId, record.id, head.operationId])}`, revision: head.logicalClock });
      }
    }
  }
  const candidates = projectSharedCalendarRecords(alternatives, groupId);
  return { ...normal, events: [...normal.events, ...candidates.events, ...exceptionEvents],
    exceptions: [...normal.exceptions, ...candidates.exceptions], unbounded };
}

export function sharedCalendarAvailability(records: readonly SharedCalendarRecord[], groupId: string,
  range: { from: LocalDate; through: LocalDate }, timeZone: string): PrivateCalendarAvailability | undefined {
  const projected = projectSharedCalendarRecords(records, groupId);
  if (!projected.events.length && !projected.conflicted) return undefined;
  const known = createLocalCalendarAvailability(projected.events, projected.exceptions, range, timeZone);
  if (!projected.conflicted) return known;
  // A conflicting series/exception is visible for review, never assumed to be free.
  return target => {
    const reading = known(target);
    return reading.conflict.kind === 'clear' ? { conflict: { kind: 'unknown', reason: 'invalid' }, busyMinutes: null } : reading;
  };
}
