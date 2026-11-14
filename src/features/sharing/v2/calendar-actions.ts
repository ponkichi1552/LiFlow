import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events';
import { validateEventDraft } from '../../../domain/calendar/events.ts';
import type { CalendarCategory, EventDraft } from '../../../domain/calendar/events';
import type { LocalDate } from '../../../domain/shared/types';
import { readSharedCalendar } from './calendar-state.ts';
import { v2ReadPoint } from './view-point.ts';
import type { SharedCalendarPayload } from './calendar-state';
import type { JsonValue } from '../operations';
import { sharedDocumentDigest } from '../crypto.ts';
import { captureV2Input } from './input-capture.ts';
import { rebasedCalendarExceptionDate } from '../../../domain/calendar/exception-slots.ts';

export interface V2CalendarCommand { eventId?: string; basisRevision?: string; scope: 'one' | 'series'; anchorDate: LocalDate | null;
  value: EventDraft | null; category: CalendarCategory | null; resetExceptions?: boolean; expectedExceptionIds?: readonly string[] }
export function v2CalendarCommandDigest(input: V2CalendarCommand, scope: { groupId: string; userId: string }) {
  return sharedDocumentDigest({ groupId: scope.groupId, userId: scope.userId, eventId: input.eventId ?? null,
    basisRevision: input.basisRevision ?? null, scope: input.scope, anchorDate: input.anchorDate, value: input.value ? validateEventDraft(input.value) : null,
    category: input.category ? { id: input.category.id, name: input.category.name, color: input.category.color } : null,
    resetExceptions: input.resetExceptions === true, expectedExceptionIds: [...(input.expectedExceptionIds ?? [])].sort() });
}

export function createV2CalendarActions(repository: ReturnType<typeof createV2EventRepository>, makeId: () => string) {
  return {
    restoreCalendarOccurrence: (command: V2CalendarCommand) => {
      const input = captureV2Input(command);
      if (!input.eventId || input.scope !== 'one' || !input.anchorDate) throw new Error('元に戻す予定を選んでください。');
      return repository.commitCurrent(async state => {
        const current = readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)!), input.eventId)[0];
        const row = current?.exceptions.find(row => row.anchorDate === input.anchorDate);
        const series = current?.heads.map(row => row.operationId).sort() ?? [];
        const heads = row?.heads.map(row => row.operationId).sort() ?? [];
        if (!current || !row || current.heads.length !== 1 || input.basisRevision !== JSON.stringify([series, heads])) throw new Error('共有予定が更新されています。再読込してください。');
        const original = current.heads[0].payload as unknown as SharedCalendarPayload;
        const operationId = makeId();
        const payload: SharedCalendarPayload = { eventId: current.id, scope: 'series', anchorDate: null,
          basisOperationIds: series, value: original.value, category: original.category, resetExceptionIds: heads };
        return [{ operationId, entityType: 'calendarEvent', entityId: operationId, operationType: 'patch', payload: payload as unknown as Record<string, JsonValue> }];
      });
    },
    saveCalendarEvent: (command: V2CalendarCommand & { intentId?: string }) => {
      const input = captureV2Input(command);
      const commit = input.intentId ? repository.commitCalendarIntent.bind(repository,
        { id: input.intentId, digest: v2CalendarCommandDigest(input, repository.scope) }) : repository.commitCurrent;
      return commit(async state => {
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
      const current = input.eventId ? readSharedCalendar(state.assessment.view, at, input.eventId)[0] : undefined;
      if (input.eventId && !current) throw new Error('共有予定が見つかりません。表示を更新してください。');
      const heads = input.scope === 'series' ? current?.heads ?? [] : current?.exceptions.find(row => row.anchorDate === input.anchorDate)?.heads ?? [];
      const basis = heads.map(row => row.operationId).sort();
      const series = current?.heads.map(row => row.operationId).sort() ?? [];
      if (current && input.basisRevision !== JSON.stringify([series, basis])) throw new Error('共有予定が更新されています。再読込し、変更内容を確認してください。');
      const exceptionIds = current?.exceptions.flatMap(row => row.heads.map(head => head.operationId)).sort() ?? [];
      if (input.resetExceptions && JSON.stringify(exceptionIds) !== JSON.stringify([...(input.expectedExceptionIds ?? [])].sort())) {
        throw new Error('個別変更が更新されています。最新の変更を確認してからリセットしてください。');
      }
      const operationId = makeId();
      const value = input.value ? validateEventDraft(input.value) : null;
      if (value && !input.category) throw new Error('共有する分類を選んでください。');
      const payload: SharedCalendarPayload = { eventId: input.eventId ?? operationId, scope: input.scope, anchorDate: input.anchorDate,
        basisOperationIds: basis, value, category: value ? { id: input.category!.id, name: input.category!.name, color: input.category!.color } : null,
        resetExceptionIds: input.resetExceptions ? exceptionIds : [] };
      const previous = current?.heads.length === 1 ? current.heads[0].payload as unknown as SharedCalendarPayload : null;
      if (input.scope === 'series' && !input.resetExceptions && value && previous?.value && previous.value.startDate !== value.startDate && current?.exceptions.length) {
        const moved = current.exceptions.map(row => {
          if (row.heads.length !== 1) throw new Error('個別変更が競合しています。予定を確認してください。');
          const old = row.heads[0].payload as unknown as SharedCalendarPayload;
          return { anchor: rebasedCalendarExceptionDate({ ...previous.value!, id: current.id, revision: 1 }, { ...value, id: current.id, revision: 2 }, row.anchorDate), old };
        });
        if (new Set(moved.map(row => row.anchor)).size !== moved.length) throw new Error('個別変更の日付が重なります。予定を確認してください。');
        payload.resetExceptionIds = exceptionIds;
        return [{ operationId, entityType: 'calendarEvent' as const, entityId: operationId, operationType: 'patch' as const, payload: payload as unknown as Record<string, JsonValue> },
          ...moved.map(row => { const id = makeId(); const body: SharedCalendarPayload = { eventId: payload.eventId, scope: 'one', anchorDate: row.anchor,
            basisOperationIds: [], value: row.old.value, category: row.old.category, resetExceptionIds: [] };
            return { operationId: id, entityType: 'calendarEvent' as const, entityId: id, operationType: 'patch' as const, payload: body as unknown as Record<string, JsonValue> }; })];
      }
      return [{ operationId, entityType: 'calendarEvent', entityId: operationId, operationType: 'patch', payload: payload as unknown as Record<string, JsonValue> }];
      });
    },
  };
}
