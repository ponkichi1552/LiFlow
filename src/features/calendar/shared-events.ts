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
  const recordsById = new Map(records.map(row => [eventId(row.id), row]));
  const groupCategories = new Map<string, CalendarCategory>(); const rawCategories = new Map<string, CalendarCategory>();
  const events: CalendarEvent[] = []; const exceptions: CalendarException[] = [];
  let conflicted = false;
  for (const record of records) {
    if (record.heads.length !== 1) { conflicted = true; continue; }
    const payload = sharedCalendarPayload(record.heads[0]); if (!payload.value || !payload.category) continue;
    const id = eventId(record.id);
    const category = (value: NonNullable<typeof payload.category>) => {
      const result = { ...value, id: `gcat.${sharedDocumentDigest([groupId, value])}`, revision: 1 };
      groupCategories.set(result.id, result); rawCategories.set(result.id, { ...value, revision: 1 }); return result.id;
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
