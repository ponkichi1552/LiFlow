import type { ChoreDefinition } from '../../domain/chores/types';
import type { initialCustomChoreOptions } from '../chores/custom-chore-options';
import type { EventDraft } from './events';
import type { ChoreClocks } from './chore-clock-input';

/** Unsaved input follows an explicit destination switch; no database write is involved. */
export type CalendarChoreInput = {
  value: EventDraft; clocks: ChoreClocks; repeat: boolean; interval: string; monthly: boolean;
  options: typeof initialCustomChoreOptions; detailsExpanded?: boolean;
  selections: { personal?: string | null; group?: string | null }; recipeId?: string;
  group?: { preset: 'common' | 'eachMember' | 'assigned' | 'rotation' | ''; memberIds: string[]; advanceOn: 'completion' | 'occurrence'; onceAssigneeIds?: string[] };
};
export function registrationChore<T extends Pick<ChoreDefinition, 'id' | 'personalRecipeId'>>(input: CalendarChoreInput | undefined, audience: 'personal' | 'group', chores: readonly T[], groupId?: string) {
  if (!input) return undefined;
  const id = input.selections[audience];
  if (id === null) return null;
  if (id !== undefined) return chores.find(chore => chore.id === id) ?? null;
  if (!input.recipeId) return null;
  return chores.find(chore => audience === 'group' ? chore.id === `${groupId}.${input.recipeId}` : chore.personalRecipeId === input.recipeId || chore.id === input.recipeId) ?? null;
}
export function registrationOptions(value: typeof initialCustomChoreOptions) {
  const { radius, before, after, minutes, load, holidayPriority, steps } = value;
  return { radius, before, after, minutes, load, holidayPriority, steps };
}
