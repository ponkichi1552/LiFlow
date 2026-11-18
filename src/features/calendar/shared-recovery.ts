import type { createV2EventRepository } from '../../platform/storage/sharing-v2-events';
import { sharedCalendarPayload } from '../sharing/v2/calendar-state.ts';
import type { CalendarFutureUndoCommand } from '../sharing/v2/calendar-future-actions';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import { sharedCalendarEventId } from './shared-events.ts';

export interface CalendarReminderUndoProof { intentId: string; digest: string; sourceId: string }
export function calendarReminderUndoProof(command: CalendarFutureUndoCommand, sourceId: string): CalendarReminderUndoProof {
  return { intentId: command.intentId, digest: sharedDocumentDigest({ kind: 'undo-calendar-future', ...command }), sourceId };
}

/** Read local recovery evidence without generating or modifying a shared operation. */
export function createSharedCalendarRecovery(repository: ReturnType<typeof createV2EventRepository>) {
  return {
    appliedCalendarReminderUndo(proof: CalendarReminderUndoProof) {
      return repository.withPrivateStorage(async tx => {
        const row = await tx.getFirstAsync<{ event_id: string }>(`SELECT r.event_id FROM sharing_v2_calendar_intent_results r
          JOIN sharing_v2_mutation_intents i ON i.intent_id=r.intent_id WHERE i.intent_id=? AND i.target_digest=? AND i.user_id=? AND i.device_id=?`,
        proof.intentId, proof.digest, repository.scope.userId, repository.scope.deviceId);
        return Boolean(row && sharedCalendarEventId(repository.scope.groupId, row.event_id) === proof.sourceId);
      });
    },
    readCalendarFutureSource(eventId: string, operationId: string) {
      return repository.readCurrent(async state => {
        const head = state.assessment.view.byId(operationId);
        if (head?.entityType !== 'calendarEvent') return null;
        const payload = sharedCalendarPayload(head);
        return payload.eventId === eventId && payload.scope === 'series' ? payload.value : null;
      });
    },
  };
}
