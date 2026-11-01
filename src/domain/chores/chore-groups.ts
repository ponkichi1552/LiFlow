import type { ChoreDefinition } from './types';
import { compareBuiltInChoreOrder } from './catalog.ts';

/** Same category and item order in settings, connected editors and guides. */
export function groupChores<T extends Pick<ChoreDefinition, 'category' | 'archived'> & { id?: string }>(chores: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const chore of [...chores].sort((a, b) => compareBuiltInChoreOrder({ id: a.id ?? '' }, { id: b.id ?? '' }))) if (!chore.archived) {
    const rows = groups.get(chore.category) ?? []; rows.push(chore); groups.set(chore.category, rows);
  }
  return [...groups];
}

export function validateChoreToggle(ids: unknown, enabled: unknown): asserts ids is string[] {
  if (typeof enabled !== 'boolean' || !Array.isArray(ids) || !ids.length || ids.length > 1000
    || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('切り替える家事を確認してください。');
}
