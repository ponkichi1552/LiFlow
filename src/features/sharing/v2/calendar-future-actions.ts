import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events';
import type { CalendarCategory, EventDraft } from '../../../domain/calendar/events';
import type { LocalDate } from '../../../domain/shared/types';
import { calendarFutureSeed, splitCalendarFuture } from '../../../domain/calendar/future-series.ts';
import { captureV2Input } from './input-capture.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { readSharedCalendar, sharedCalendarPayload, type SharedCalendarPayload, type SharedCalendarRecord } from './calendar-state.ts';
import { v2ReadPoint } from './view-point.ts';
import type { V2CalendarCommand } from './calendar-actions';
import type { SharedOperation } from '../operations';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger';
import { assertCalendarMonthDatesCompatibility } from './calendar-compatibility.ts';

const ids = (rows: readonly SharedOperation[]) => rows.map(row => row.operationId).sort();
const exceptionIds = (record: SharedCalendarRecord) => record.exceptions.flatMap(row => ids(row.heads)).sort();
const sameIds = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
export interface CalendarFutureUndoCommand {
  sourceId: string; branchId: string; sourceValue: EventDraft; sourceCategory: CalendarCategory;
  exceptions: { anchorDate: LocalDate; value: EventDraft | null; category: SharedCalendarPayload['category'] }[];
  sourceHeads: string[]; sourceExceptions: string[]; branchHeads: string[]; branchExceptions: string[]; intentId: string;
}
export function calendarFutureUndoCommand(original: SharedCalendarRecord, operations: readonly SharedOperation[], intentId: string): CalendarFutureUndoCommand | null {
  const first = operations[0]; if (!first) return null;
  const branchId = sharedCalendarPayload(first).eventId, source = sharedCalendarPayload(original.heads[0]);
  if (!source.value || !source.category) return null;
  const of = (eventId: string, scope: 'one' | 'series') => operations.filter(row => { const payload = sharedCalendarPayload(row); return payload.eventId === eventId && payload.scope === scope; });
  return { sourceId: original.id, branchId, sourceValue: source.value, sourceCategory: { ...source.category, revision: 1 },
    exceptions: original.exceptions.map(row => { const payload = sharedCalendarPayload(row.heads[0]); return { anchorDate: row.anchorDate, value: payload.value, category: payload.category }; }),
    sourceHeads: ids(of(original.id, 'series').slice(-1)), sourceExceptions: ids(of(original.id, 'one')),
    branchHeads: ids(of(branchId, 'series').slice(-1)), branchExceptions: ids(of(branchId, 'one')), intentId };
}
export function createV2CalendarFutureActions(repository: ReturnType<typeof createV2EventRepository>, makeId: () => string, digest: (input: V2CalendarCommand, scope: { groupId: string; userId: string }) => string) {
  const operation = (payload: SharedCalendarPayload, operationId = makeId()): SharedOperationDraft => ({ operationId, entityType: 'calendarEvent', entityId: operationId, operationType: 'patch', payload: payload as unknown as SharedOperationDraft['payload'] });
  const one = (eventId: string, anchorDate: LocalDate, value: EventDraft | null, category: SharedCalendarPayload['category']) => operation({ eventId, scope: 'one', anchorDate, value, category, basisOperationIds: [], resetExceptionIds: [] });
  return {
    saveCalendarFutureEvent(command: V2CalendarCommand & { intentId?: string }) {
      const input = captureV2Input(command);
      if (input.scope !== 'future' || !input.eventId || !input.anchorDate || !input.value || !input.category || input.resetExceptions) throw new Error('変更する繰り返しの範囲を確認してください。');
      const commit = input.intentId ? repository.commitCalendarIntent.bind(repository, { id: input.intentId, digest: digest(input, repository.scope) }) : repository.commitCurrent;
      return commit(async state => {
        assertCalendarMonthDatesCompatibility(input.value, state.archive.at(-1)!.body.schedulerVersion);
        const current = readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)!), input.eventId)[0];
        if (!current || current.heads.length !== 1 || input.basisRevision !== JSON.stringify([ids(current.heads), ids(current.heads)]) || !sameIds(exceptionIds(current), input.expectedExceptionIds ?? [])) throw new Error('共有予定が更新されています。再読込してください。');
        if (current.exceptions.some(row => row.heads.length !== 1)) throw new Error('個別変更が競合しています。予定を確認してください。');
        const original = sharedCalendarPayload(current.heads[0]); if (!original.value || !original.category) throw new Error('共有予定が見つかりません。');
        const rows = current.exceptions.map(row => ({ eventId: current.id, anchorDate: row.anchorDate, revision: 1, override: sharedCalendarPayload(row.heads[0]).value }));
        const split = splitCalendarFuture({ ...original.value, id: current.id, revision: 1 }, input.anchorDate!, input.value!, rows);
        const branchId = makeId(), category = { id: input.category!.id, name: input.category!.name, color: input.category!.color };
        const seed = calendarFutureSeed(split.next, split.following.map(row => row.anchorDate));
        const result: SharedOperationDraft[] = [operation({ eventId: branchId, scope: 'series', anchorDate: null, value: seed, category, basisOperationIds: [], resetExceptionIds: [] }, branchId),
          operation({ eventId: current.id, scope: 'series', anchorDate: null, value: split.past, category: split.past ? original.category : null, basisOperationIds: ids(current.heads), resetExceptionIds: exceptionIds(current) })];
        const oldPayload = (anchor: LocalDate) => sharedCalendarPayload(current.exceptions.find(row => row.anchorDate === anchor)!.heads[0]);
        for (const row of split.previous) { const old = oldPayload(row.anchorDate); result.push(one(current.id, row.anchorDate, old.value, old.category)); }
        for (const row of split.following) { const old = oldPayload(row.originalAnchorDate); result.push(one(branchId, row.anchorDate, old.value, old.category)); }
        if (JSON.stringify(seed) !== JSON.stringify(split.next)) result.push(operation({ eventId: branchId, scope: 'series', anchorDate: null, value: split.next, category, basisOperationIds: [branchId], resetExceptionIds: [] }));
        return result;
      });
    },
    undoCalendarFutureEvent(command: CalendarFutureUndoCommand) {
      const input = captureV2Input(command);
      return repository.commitCalendarIntent({ id: input.intentId, digest: sharedDocumentDigest({ kind: 'undo-calendar-future', ...input }) }, async state => {
        assertCalendarMonthDatesCompatibility(input.sourceValue, state.archive.at(-1)!.body.schedulerVersion);
        for (const row of input.exceptions) assertCalendarMonthDatesCompatibility(row.value, state.archive.at(-1)!.body.schedulerVersion);
        const records = readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)!));
        const source = records.find(row => row.id === input.sourceId), branch = records.find(row => row.id === input.branchId);
        if (!source || !branch || !sameIds(ids(source.heads), input.sourceHeads) || !sameIds(exceptionIds(source), input.sourceExceptions)
          || !sameIds(ids(branch.heads), input.branchHeads) || !sameIds(exceptionIds(branch), input.branchExceptions)) throw new Error('予定が更新されています。上書きせずに停止しました。');
        return [operation({ eventId: source.id, scope: 'series', anchorDate: null, value: input.sourceValue, category: { id: input.sourceCategory.id, name: input.sourceCategory.name, color: input.sourceCategory.color }, basisOperationIds: ids(source.heads), resetExceptionIds: exceptionIds(source) }),
          operation({ eventId: branch.id, scope: 'series', anchorDate: null, value: null, category: null, basisOperationIds: ids(branch.heads), resetExceptionIds: exceptionIds(branch) }),
          ...input.exceptions.map(row => one(source.id, row.anchorDate, row.value, row.category))];
      });
    },
  };
}
