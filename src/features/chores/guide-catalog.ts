import type { ChoreDefinition } from '../../domain/chores/types';
import { commonChoreLinks } from '../planner/common-chore-links.ts';
import { canonicalBuiltInChoreName } from '../../domain/chores/catalog.ts';

/** Presentation only: keep both original definitions and their independent settings intact. */
export function unifiedGuideCatalog(shared: readonly ChoreDefinition[], personal: readonly ChoreDefinition[]) {
  const sharedRows = shared.filter(chore => !chore.archived);
  const personalRows = personal.filter(chore => !chore.archived);
  // Identity matching includes inactive definitions; activation still governs which source is shown.
  const links = commonChoreLinks(personalRows, sharedRows.map(chore => ({ ...chore, enabled: true })));
  const activeShared = new Set(sharedRows.filter(chore => chore.enabled).map(chore => chore.id));
  const hiddenPersonal = new Set(links.filter(link => activeShared.has(link.sharedChoreId)).map(link => link.personalChoreId));
  const hiddenShared = new Set(links.filter(link => !activeShared.has(link.sharedChoreId)).map(link => link.sharedChoreId));
  return [...sharedRows.filter(chore => !hiddenShared.has(chore.id)).map(chore => ({ ...chore, id: `shared:${chore.id}` })),
    ...personalRows.filter(chore => !hiddenPersonal.has(chore.id)).map(chore => ({ ...chore, id: `personal:${chore.id}` }))];
}

export function guideCatalogSelection(chores: readonly ChoreDefinition[], source: 'shared' | 'personal', original?: Pick<ChoreDefinition, 'id' | 'name'>) {
  if (!original) return undefined;
  const direct = `${source}:${original.id}`;
  if (chores.some(chore => chore.id === direct)) return direct;
  const matches = chores.filter(chore => canonicalBuiltInChoreName(chore.name) === canonicalBuiltInChoreName(original.name));
  return matches.length === 1 ? matches[0].id : undefined;
}
