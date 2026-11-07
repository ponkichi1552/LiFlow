import { validateEventDraft, isCalendarAnchor } from '../../../domain/calendar/events.ts';
import type { CalendarCategory, EventDraft } from '../../../domain/calendar/events';
import type { LocalDate } from '../../../domain/shared/types';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { SharedOperation, JsonValue } from '../operations';
import { assertSharedIdentifier } from '../identifier.ts';
import type { V2HistoryView } from './history-view';
import { maximalCausalFacts } from './causal-facts.ts';

export interface SharedCalendarPayload {
  eventId: string; scope: 'series' | 'one'; anchorDate: LocalDate | null;
  basisOperationIds: string[]; value: EventDraft | null; category: Pick<CalendarCategory, 'id' | 'name' | 'color'> | null;
  resetExceptionIds: string[];
}
export interface SharedCalendarRecord {
  id: string; creatorUserId: string; heads: SharedOperation[];
  exceptions: { anchorDate: LocalDate; heads: SharedOperation[] }[];
}
const equalIds = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const body = (operation: SharedOperation) => operation.payload as unknown as SharedCalendarPayload;
function fail(): never { throw new Error('共有予定の権限または編集元を確認してください。'); }

/** The encrypted event contains the explicitly selected event and category only. */
export function validateSharedCalendarPayload(input: Record<string, JsonValue>, operationId: string): void {
  const payload = input as unknown as SharedCalendarPayload;
  const fields = ['eventId', 'scope', 'anchorDate', 'basisOperationIds', 'value', 'category', 'resetExceptionIds'];
  if (Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))) fail();
  assertSharedIdentifier(payload.eventId);
  if (!['series', 'one'].includes(payload.scope) || !Array.isArray(payload.basisOperationIds) || payload.basisOperationIds.length > 64
    || new Set(payload.basisOperationIds).size !== payload.basisOperationIds.length) fail();
  payload.basisOperationIds.forEach(assertSharedIdentifier);
  if (!Array.isArray(payload.resetExceptionIds) || payload.resetExceptionIds.length > 1000 || new Set(payload.resetExceptionIds).size !== payload.resetExceptionIds.length
    || payload.scope === 'one' && payload.resetExceptionIds.length) fail();
  payload.resetExceptionIds.forEach(assertSharedIdentifier);
  if (payload.scope === 'series' ? payload.anchorDate !== null : typeof payload.anchorDate !== 'string') fail();
  if (payload.anchorDate !== null) parseLocalDate(payload.anchorDate);
  if (payload.value !== null) {
    const value = validateEventDraft(payload.value); const category = payload.category;
    if (JSON.stringify(Object.keys(payload.value).sort()) !== JSON.stringify(Object.keys(value).sort())) fail();
    if (!category || Object.keys(category).sort().join(',') !== 'color,id,name' || category.id !== value.categoryId
      || typeof category.name !== 'string' || !category.name.trim() || category.name.length > 40 || !/^#[0-9a-f]{6}$/iu.test(category.color)) fail();
  } else if (payload.category !== null) fail();
  if (payload.eventId === operationId && (payload.scope !== 'series' || payload.basisOperationIds.length || payload.value === null)) fail();
}

export function readSharedCalendar(view: V2HistoryView, at?: SharedOperation, eventId?: string): SharedCalendarRecord[] {
  const source = eventId === undefined ? view.ofType('calendarEvent') : view.calendarFactsFor(eventId);
  const facts = at ? view.observed(source, at) : source;
  const groups = new Map<string, SharedOperation[]>();
  for (const operation of facts) { const id = body(operation).eventId; const list = groups.get(id) ?? []; list.push(operation); groups.set(id, list); }
  return [...groups].flatMap(([id, operations]) => {
    const create = operations.find(operation => operation.operationId === id); if (!create) return [];
    const reset = new Set(operations.flatMap(operation => body(operation).resetExceptionIds));
    const exceptions = new Map<LocalDate, SharedOperation[]>();
    for (const operation of operations) if (body(operation).scope === 'one') {
      const date = body(operation).anchorDate!; const list = exceptions.get(date) ?? []; list.push(operation); exceptions.set(date, list);
    }
    return [{ id, creatorUserId: create.authorUserId,
      heads: maximalCausalFacts(operations.filter(operation => body(operation).scope === 'series')),
      // Determine causal heads before removing reset heads. Filtering first
      // would resurrect an older edit that the reset head had superseded.
      exceptions: [...exceptions].flatMap(([anchorDate, values]) => {
        const heads = maximalCausalFacts(values).filter(operation => !reset.has(operation.operationId));
        return heads.length ? [{ anchorDate, heads }] : [];
      }) }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Rechecked at both the signed original epoch and the server receipt epoch. */
export function authorizeSharedCalendarOperation(view: V2HistoryView, operation: SharedOperation, admin: boolean): void {
  const payload = body(operation);
  if (payload.eventId === operation.operationId) {
    if (view.observed(view.calendarFactsFor(payload.eventId), operation).length) fail();
    return;
  }
  const current = readSharedCalendar(view, operation, payload.eventId)[0];
  if (!current || !admin && current.creatorUserId !== operation.authorUserId) fail();
  const heads = payload.scope === 'series' ? current.heads : current.exceptions.find(row => row.anchorDate === payload.anchorDate)?.heads ?? [];
  if (!equalIds(heads.map(row => row.operationId), payload.basisOperationIds)) fail();
  const exceptionIds = current.exceptions.flatMap(row => row.heads.map(head => head.operationId));
  if (payload.resetExceptionIds.some(id => !exceptionIds.includes(id))) fail();
  if (payload.scope === 'series' && payload.value) {
    const value = payload.value;
    const changed = current.heads.some(head => {
      const old = body(head).value;
      return old && (old.startDate !== value.startDate || old.recurrence !== value.recurrence || old.untilDate !== value.untilDate
        || JSON.stringify(old.customRecurrence) !== JSON.stringify(value.customRecurrence));
    });
    if (changed && !equalIds(exceptionIds, payload.resetExceptionIds)) fail();
  }
  if (payload.scope === 'one') {
    if (current.heads.length !== 1 || body(current.heads[0]).value === null) fail();
    const source = body(current.heads[0]).value!;
    if (!isCalendarAnchor({ ...source, id: current.id, revision: 1 }, payload.anchorDate!)) fail();

  }
}

export function sharedCalendarPayload(operation: SharedOperation): SharedCalendarPayload { return body(operation); }
