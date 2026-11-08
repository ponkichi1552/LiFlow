import { createPersonalChoreDefinitions, personalChoreRecipe, togglePersonalCatalogSelection } from '../../../domain/chores/personal-catalog.ts';
import type { JsonValue } from '../operations';

/** Both audiences use bundled recipes. No private database, settings or history is read. */
export function standardSharedChores(groupId: string): { id: string; payload: Record<string, JsonValue> }[] {
  return createPersonalChoreDefinitions('shared-catalog').map(chore => {
    const periodic = ['frequent', 'balanced', 'relaxed'].every(mode => Number.isSafeInteger(chore.frequencyDaysByMode[mode as keyof typeof chore.frequencyDaysByMode]));
    const payload: Record<string, JsonValue> = {
      name: chore.name, category: chore.category, description: chore.description, enabled: false,
      requiresCycleSelection: !periodic, windowRadiusDays: chore.windowRadiusDays, maxShiftDays: chore.maxShiftDays,
      load: chore.load, holidayPriority: chore.holidayPriority, everyday: chore.everyday ?? false,
      estimatedMinutes: chore.estimatedMinutes!, locationOrAppliance: chore.locationOrAppliance ?? chore.name,
      instructions: [...chore.instructions], tools: [...chore.tools], cautions: [...chore.cautions],
      trivia: JSON.parse(JSON.stringify(chore.trivia ?? [])), sourceNotes: [],
      ...(periodic ? { frequencyDaysByMode: { ...chore.frequencyDaysByMode } } : {}),
      ...(chore.laundryDryingPreference ? { laundryDryingPreference: chore.laundryDryingPreference } : {}),
    };
    // A use/condition/seasonal recipe never receives an invented daily interval.
    if (!periodic) payload.schedulingNotes = personalChoreRecipe(chore.id)!.cadenceLabels.balanced;
    return { id: `${groupId}.${chore.id}`, payload };
  });
}

export function sharedRecipeId(groupId: string, choreId: string): string | undefined {
  if (!choreId.startsWith(`${groupId}.`)) return undefined;
  const id = choreId.slice(groupId.length + 1);
  return personalChoreRecipe(id) ? id : undefined;
}

/** Exact bundled relationships, including splits, are the same in personal and shared settings. */
export function excludedSharedChores(groupId: string, choreId: string, enabledIds: readonly string[]): string[] {
  const recipeId = sharedRecipeId(groupId, choreId); if (!recipeId) return [];
  const current = enabledIds.flatMap(id => sharedRecipeId(groupId, id) ?? []);
  const retained = new Set(togglePersonalCatalogSelection(current, recipeId, true));
  return enabledIds.filter(id => { const recipe = sharedRecipeId(groupId, id); return recipe !== undefined && !retained.has(recipe); });
}
