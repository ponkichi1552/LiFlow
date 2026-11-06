import type { ChoreDefinition } from '../../domain/chores/types';
// Reviewed work meanings from catalog 6, not a substring match for equipment
// cleaning such as washing-machine filters. Seasonal storage never uses weather.
const weatherRecipes = new Set([7, 8, 10, 11, 15, 16, 17, 18, 21, 22, 23, 69, 72, 73, 74, 75, 76, 79, 80]
  .map(value => `liflow-catalog-6.${String(value).padStart(3, '0')}`));
export function personalChoreUsesWeather(chore: ChoreDefinition) {
  if (chore.personalSchedulingKind === 'seasonal' || chore.laundryDryingPreference === 'indoors') return false;
  return Boolean(chore.personalRecipeId && weatherRecipes.has(chore.personalRecipeId) || chore.laundryDryingPreference);
}
