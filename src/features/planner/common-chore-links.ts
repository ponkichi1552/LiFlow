import type { ChoreCompletion, ChoreDefinition } from '../../domain/chores/types';
import { canonicalBuiltInChoreName } from '../../domain/chores/catalog.ts';

const nameKey = canonicalBuiltInChoreName;
export interface CommonChoreLink { sharedChoreId: string; personalChoreId: string }

/** Group definitions govern the common row; the original personal definition is never rewritten. */
type LinkableChore = Pick<ChoreDefinition, 'id' | 'name' | 'enabled' | 'archived'>;
export function commonChoreLinks(personal: readonly LinkableChore[], shared: readonly LinkableChore[]): CommonChoreLink[] {
  const candidates = new Map<string, LinkableChore[]>();
  for (const chore of shared.filter(chore => chore.enabled && !chore.archived)) {
    const key = nameKey(chore.name); const rows = candidates.get(key) ?? []; rows.push(chore); candidates.set(key, rows);
  }
  return personal.flatMap(chore => {
    const rows = candidates.get(nameKey(chore.name));
    return !chore.archived && rows?.length === 1 ? [{ sharedChoreId: rows[0].id, personalChoreId: chore.id }] : [];
  });
}

const prefix = 'shared-home:';
export function sharedMirrorEntryId(groupId: string, sharedChoreId: string, occurrenceId: string, personalChoreId: string) {
  return prefix + JSON.stringify([1, groupId, sharedChoreId, occurrenceId, personalChoreId]);
}
export function parseSharedMirrorEntryId(value?: string | null) {
  if (!value?.startsWith(prefix)) return null;
  try {
    const data: unknown = JSON.parse(value.slice(prefix.length));
    if (!Array.isArray(data) || data.length !== 5 || data[0] !== 1 || data.slice(1).some(part => typeof part !== 'string' || !part)) return null;
    return { groupId: data[1] as string, sharedChoreId: data[2] as string, occurrenceId: data[3] as string, personalChoreId: data[4] as string };
  } catch { return null; }
}
export interface CommonCompletionSource {
  groupId: string;
  chores: readonly LinkableChore[];
  /** Canonical records include explicit incomplete/undone outcomes. Absence never means undo. */
  completions: readonly ChoreCompletion[];
}
