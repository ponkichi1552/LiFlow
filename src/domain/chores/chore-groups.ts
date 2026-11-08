import { compareBuiltInChoreOrder } from './catalog.ts';
import { choreCategoryOrder, choreDisplayCategory, choreFamilies, comparePresentedChoreOrder, type PresentedChore } from './chore-presentation.ts';

/** Same category and item order in settings, connected editors and guides. */
export function groupChores<T extends PresentedChore>(chores: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  const visible = chores.filter(chore => !chore.archived).sort((a, b) =>
    comparePresentedChoreOrder(a, b)
      || compareBuiltInChoreOrder({ id: a.id ?? '' }, { id: b.id ?? '' }));
  for (const family of choreFamilies(visible)) {
    const category = choreDisplayCategory(family.chore);
    const rows = groups.get(category) ?? []; rows.push(family.chore, ...family.children); groups.set(category, rows);
  }
  const rank = (category: string) => { const index = choreCategoryOrder.indexOf(category as typeof choreCategoryOrder[number]); return index < 0 ? choreCategoryOrder.length : index; };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b));
}

export function validateChoreToggle(ids: unknown, enabled: unknown): asserts ids is string[] {
  if (typeof enabled !== 'boolean' || !Array.isArray(ids) || !ids.length || ids.length > 1000
    || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('切り替える家事を確認してください。');
}
