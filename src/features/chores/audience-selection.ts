import type { ChoreDefinition } from '../../domain/chores/types';
import { canonicalBuiltInChoreName, CHORE_CATALOG } from '../../domain/chores/catalog.ts';

export type ChoreAudienceSelection = Pick<ChoreDefinition, 'name' | 'category'>;

/** Navigation only: matching definitions never copies or merges their settings. */
export function choreInAudience(chores: readonly ChoreDefinition[], original?: ChoreAudienceSelection) {
  const available = chores.filter(chore => !chore.archived);
  if (!original) return available[0]?.id;
  const matches = available.filter(chore => canonicalBuiltInChoreName(chore.name) === canonicalBuiltInChoreName(original.name));
  return matches.length === 1 ? matches[0].id : available.find(chore => chore.category === original.category)?.id ?? available[0]?.id;
}

/** A guide destination must describe the same chore, never a nearby category entry. */
export function matchingGuideChore(chores: readonly ChoreDefinition[], original?: ChoreDefinition) {
  if (!original) return undefined;
  const available = chores.filter(chore => !chore.archived);
  const recipe = original.personalRecipeId ?? original.id;
  const identity = available.filter(chore => chore.id === original.id || chore.personalRecipeId === recipe || chore.id.endsWith(`.${recipe}`));
  if (identity.length === 1) return identity[0].id;
  const legacy = (value: ChoreDefinition) => !value.customPersonal && CHORE_CATALOG.some(chore => chore.id === value.id || value.id.endsWith(`.${chore.id}`));
  if (!legacy(original)) return undefined;
  const matches = available.filter(chore => legacy(chore) && canonicalBuiltInChoreName(chore.name) === canonicalBuiltInChoreName(original.name));
  return matches.length === 1 ? matches[0].id : undefined;
}
