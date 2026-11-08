import type { ChoreCompletion } from '../../domain/chores/types';
import { parseSharedMirrorEntryId } from './common-chore-links.ts';
import { compareCompletionInstants } from './history-selection.ts';

/** The current group's authoritative record replaces its local learning mirror, even if it is private to another member. */
export function selectPersonalHistory(completions: readonly ChoreCompletion[], { choreId, groupId, limit = 100 }: { choreId?: string; groupId?: string; limit?: number } = {}) {
  return completions.filter(row => row.outcome === 'completed' && (!choreId || row.choreId === choreId)
    && (!groupId || parseSharedMirrorEntryId(row.scheduleEntryId)?.groupId !== groupId)).sort(compareCompletionInstants).slice(0, limit);
}
