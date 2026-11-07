import { causallyPrecedes } from '../operations.ts';
import type { SharedOperation } from '../operations';
import { sharedDocumentDigest } from '../crypto.ts';
import type { V2HistoryView } from './history-view';
import type { V2RetainedRoundState } from './history-retention-schema';
import { sharedLocalDate } from '../group-clock.ts';

/** Current completion state is separate from deleted historical reports; no author operation is invented. */
export function v2RetainedCompletions(view: V2HistoryView, at: SharedOperation): V2RetainedRoundState[] {
  const body = view.retentionAt(at); if (!body) return [];
  const digest = sharedDocumentDigest(body);
  const undos = view.ofType('retainedCompletionUndo').filter(op => causallyPrecedes(op, at) && op.payload.checkpointId === digest);
  const key = (choreId: unknown, anchorDate: unknown, subjectUserId: unknown) => JSON.stringify([choreId, anchorDate, subjectUserId]);
  const removedByRound = new Map<string, Set<string>>();
  for (const op of undos) {
    const id = key(op.payload.choreId, op.payload.anchorDate, op.payload.subjectUserId);
    const removed = removedByRound.get(id) ?? new Set<string>();
    for (const recorder of op.payload.recorderUserIds as string[]) removed.add(recorder);
    removedByRound.set(id, removed);
  }
  return body.roundStates.map(state => {
    const removed = removedByRound.get(key(state.choreId, state.anchorDate, state.subjectUserId));
    const reports = state.reports.filter(report => !removed?.has(report.recorderUserId));
    const instant = reports.length ? Math.min(...reports.map(report => report.instant)) : state.instant;
    return { ...state, reports: reports.map(report => ({ ...report })), instant, date: sharedLocalDate(new Date(instant), body.timeZone) };
  });
}
