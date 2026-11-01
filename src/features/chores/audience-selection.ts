import type { ChoreDefinition } from '../../domain/chores/types';
import { canonicalBuiltInChoreName } from '../../domain/chores/catalog.ts';

export type ChoreAudienceSelection = Pick<ChoreDefinition, 'name' | 'category'>;

/** Navigation only: matching definitions never copies or merges their settings. */
export function choreInAudience(chores: readonly ChoreDefinition[], original?: ChoreAudienceSelection) {
  const available = chores.filter(chore => !chore.archived);
  if (!original) return available[0]?.id;
  const matches = available.filter(chore => canonicalBuiltInChoreName(chore.name) === canonicalBuiltInChoreName(original.name));
  return matches.length === 1 ? matches[0].id : available.find(chore => chore.category === original.category)?.id ?? available[0]?.id;
}
