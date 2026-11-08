import type { ChoreDefinition } from '../../domain/chores/types';
import { canonicalBuiltInChoreName } from '../../domain/chores/catalog.ts';
import { presentedChoreRecipe } from '../../domain/chores/chore-presentation.ts';
import { sharedDocumentDigest } from '../sharing/crypto.ts';

export const personalChoicePrefix = 'personal-choice:';
export const personalChoiceId = (id: string) => `${personalChoicePrefix}${id}`;
export const personalChoiceSourceId = (id: string) => id.startsWith(personalChoicePrefix) ? id.slice(personalChoicePrefix.length) : undefined;
export const sharedPersonalChoiceId = (userId: string, groupId: string, personalChoreId: string) =>
  `personal-choice.${sharedDocumentDigest({ userId, groupId, personalChoreId })}`;

export function matchingSharedChores(personal: Pick<ChoreDefinition, 'id' | 'name' | 'category' | 'personalRecipeId'>,
  shared: readonly Pick<ChoreDefinition, 'id' | 'name' | 'category' | 'personalRecipeId'>[]) {
  const recipe = presentedChoreRecipe(personal)?.id;
  const name = canonicalBuiltInChoreName(personal.name).normalize('NFKC').trim();
  return shared.filter(chore => recipe && presentedChoreRecipe(chore)?.id === recipe
    || canonicalBuiltInChoreName(chore.name).normalize('NFKC').trim() === name);
}

/** Only missing definitions become unchecked choices. No private history or setting is merged into the group. */
export function availablePersonalChoreChoices(userId: string, groupId: string, personal: readonly ChoreDefinition[],
  shared: readonly Pick<ChoreDefinition, 'id' | 'name' | 'category' | 'personalRecipeId'>[]) {
  return personal.filter(chore => !chore.archived
    && !shared.some(row => row.id === sharedPersonalChoiceId(userId, groupId, chore.id))
    && !matchingSharedChores(chore, shared).length).map(chore => ({ ...chore, id: personalChoiceId(chore.id), enabled: false }));
}
