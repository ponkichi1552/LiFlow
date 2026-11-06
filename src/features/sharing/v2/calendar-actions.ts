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
    saveCalendarEvent: (command: V2CalendarCommand & { intentId?: string }) => {
      const input = captureV2Input(command);
      const commit = input.intentId ? repository.commitCalendarIntent.bind(repository,
        { id: input.intentId, digest: v2CalendarCommandDigest(input, repository.scope) }) : repository.commitCurrent;
      return commit(async state => {
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
      const current = input.eventId ? readSharedCalendar(state.assessment.view, at).find(event => event.id === input.eventId) : undefined;
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
      return [{ operationId, entityType: 'calendarEvent', entityId: operationId, operationType: 'patch', payload: payload as unknown as Record<string, JsonValue> }];
      });
    },
  };
}
