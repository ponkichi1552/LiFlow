import data from './personal-catalog-data.json';
import type { ChoreDefinition, ChoreLoad, FrequencyMode } from './types';
import type { AdaptiveHistoryPolicy } from '../scheduling/adaptive/history';
import { adaptiveWindowRadius } from '../scheduling/adaptive/placement.ts';
import { choreCadenceLabel } from './cycle-policy.ts';

export type PersonalChoreCadence = { kind: 'days'; days: number } | { kind: 'asNeeded' | 'afterUse' | 'collection' | 'held' }
  | { kind: 'seasonal'; seasonalTask: 'clothingStorage' };
export interface PersonalChoreRecipe {
  id: string; name: string; category: string; scope: string; estimatedMinutes: number; load: ChoreLoad; loadExplanation: string;
  modes: Record<FrequencyMode, PersonalChoreCadence>; cadenceLabels: Record<FrequencyMode, string>;
  initialEnabled: boolean; availability: 'available' | 'held'; splitParentId: string | null; exclusiveWithParent: boolean;
  replacesRecipeIds: readonly string[];
  integratedInto: readonly string[]; tools: readonly string[]; instructions: readonly string[]; cautions: readonly string[];
  trivia: readonly { id: string; body: string }[];
}
/** Bundled, generated specification data. The active repository is switched only after its planner adapter is ready. */
export const PERSONAL_CHORE_CATALOG = data.recipes as unknown as readonly PersonalChoreRecipe[];
export const PERSONAL_CHORE_CATALOG_VERSION = data.catalogVersion;
export const PERSONAL_CHORE_CATALOG_SOURCE_SHA256 = data.sourceSha256;
const byId = new Map(PERSONAL_CHORE_CATALOG.map(recipe => [recipe.id, recipe]));
const orderById = new Map(PERSONAL_CHORE_CATALOG.map((recipe, index) => [recipe.id, index]));
export function comparePersonalChoreOrder(a: Pick<ChoreDefinition, 'id'>, b: Pick<ChoreDefinition, 'id'>) {
  return (orderById.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderById.get(b.id) ?? Number.MAX_SAFE_INTEGER);
}
export const personalChoreRecipe = (id: string) => byId.get(id);
export function initialPersonalChoreSelection() { return PERSONAL_CHORE_CATALOG.filter(recipe => recipe.initialEnabled).map(recipe => recipe.id); }

/** First setup stays short. Additional and split recipes remain available in the full guide/settings catalogue. */
export function personalOnboardingChores(chores: readonly ChoreDefinition[]): ChoreDefinition[] {
  return chores.filter(chore => !chore.archived && !chore.requiresCycleSelection
    && (!chore.personalRecipeId || byId.get(chore.personalRecipeId)?.initialEnabled === true));
}

/** Explicit finite intervals only. No one-day surrogate is manufactured for a use/condition/display-only entry. */
export function personalRecipeInitialDays(recipe: PersonalChoreRecipe, mode: FrequencyMode): number | undefined {
  const cadence = recipe.modes[mode]; return cadence.kind === 'days' ? cadence.days : undefined;
}

/** No missing cadence is converted into a numeric placeholder for the legacy definition interface. */
export function createPersonalChoreDefinitions(householdId: string): ChoreDefinition[] {
  return PERSONAL_CHORE_CATALOG.filter(recipe => recipe.availability === 'available' && recipe.modes.balanced.kind !== 'collection').map(recipe => {
    const frequencyDaysByMode = Object.fromEntries((['frequent', 'balanced', 'relaxed'] as const).flatMap(mode => {
      const days = personalRecipeInitialDays(recipe, mode); return days === undefined ? [] : [[mode, days]];
    }));
    const balanced = personalRecipeInitialDays(recipe, 'balanced');
    const definition: ChoreDefinition = { id: recipe.id, personalRecipeId: recipe.id,
      personalSchedulingKind: recipe.modes.balanced.kind === 'seasonal' ? 'seasonal' : 'personal', householdId, name: recipe.name, category: recipe.category, description: recipe.scope,
      enabled: recipe.initialEnabled, frequencyDaysByMode, requiresCycleSelection: false,
      cadenceLabelsByMode: { ...recipe.cadenceLabels },
      windowRadiusDays: balanced === undefined ? 0 : adaptiveWindowRadius(balanced),
      maxShiftDays: balanced === undefined ? 0 : Math.floor((adaptiveWindowRadius(balanced) * 2 + 1) * 1.2),
      load: recipe.load, holidayPriority: recipe.load === 'heavy', everyday: Object.values(frequencyDaysByMode).length === 3 && Object.values(frequencyDaysByMode).every(days => days === 1),
      estimatedMinutes: recipe.estimatedMinutes, tools: [...recipe.tools], instructions: [...recipe.instructions], cautions: [...recipe.cautions],
      trivia: recipe.trivia.map(tip => {
        const title = /^([^：:]+)[：:]\s*([\s\S]*)$/u.exec(tip.body);
        return { id: tip.id, title: title?.[1] ?? '', body: title?.[2] ?? tip.body };
      }), sourceNotes: [], locationOrAppliance: recipe.name,
      ...(['衣類・タオルの洗濯', '衣類だけの洗濯', 'タオルだけの洗濯', '寝具カバーの交換・洗濯', '毛布の洗濯'].includes(recipe.name)
        ? { laundryDryingPreference: 'either' as const } : {}) };
    definition.personalScheduleDefaults = { frequencyDaysByMode: { ...frequencyDaysByMode }, load: definition.load,
      windowRadiusDays: definition.windowRadiusDays, maxShiftDays: definition.maxShiftDays, holidayPriority: definition.holidayPriority,
      everyday: definition.everyday, requiresCycleSelection: false, ...(definition.laundryDryingPreference ? { laundryDryingPreference: definition.laundryDryingPreference } : {}) };
    return definition;
  });
}
export function personalChoreHistoryPolicy(chore: ChoreDefinition, mode: FrequencyMode): AdaptiveHistoryPolicy {
  const recipe = chore.personalRecipeId ? byId.get(chore.personalRecipeId) : undefined;
  if (!recipe && (chore.applianceId || chore.applianceCareSource)) {
    const days = chore.manufacturerRecommendedIntervalDays ?? null;
    if (days !== null && (!Number.isSafeInteger(days) || days <= 0)) throw new Error('メーカー指定の周期を確認してください。');
    return { choreId: chore.id, kind: 'personal', mode, initialDays: { frequent: days, balanced: days, relaxed: days },
      enabled: chore.enabled && !chore.requiresCycleSelection, fixedDays: chore.userIntervalDays ?? chore.recommendedCycleDays ?? null,
      version: `appliance-policy-1:${chore.id}` };
  }
  if (!recipe || recipe.id !== chore.id) throw new Error('新しい家事カタログの識別子を確認してください。');
  return { choreId: chore.id, kind: recipe.modes.balanced.kind === 'seasonal' ? 'seasonal' : recipe.modes.balanced.kind === 'collection' ? 'display' : 'personal',
    mode, initialDays: Object.fromEntries((['frequent', 'balanced', 'relaxed'] as const).map(mode => [mode, personalRecipeInitialDays(recipe, mode) ?? null])) as AdaptiveHistoryPolicy['initialDays'],
    enabled: chore.enabled, fixedDays: chore.userIntervalDays ?? chore.recommendedCycleDays ?? null,
    version: `catalog-${PERSONAL_CHORE_CATALOG_VERSION}:${recipe.id}` };
}
/** Only invoked by a verified private repository; shared Scheduler inputs never use this branch. */
export function usesPersonalAdaptivePlanner(chore: ChoreDefinition): boolean {
  return Boolean(chore.personalRecipeId || chore.applianceId || chore.applianceCareSource);
}
export function personalChoreCadenceLabel(chore: ChoreDefinition, mode: FrequencyMode): string {
  return choreCadenceLabel(chore, mode);
}

/** Selecting an explicit split never invents a remainder or completes/activates its siblings. */
export function togglePersonalCatalogSelection(selected: readonly string[], id: string, enabled: boolean): string[] {
  const recipe = byId.get(id);
  if (!recipe || recipe.availability === 'held' || recipe.modes.balanced.kind === 'collection') throw new Error('通常の家事として選択できない項目です。');
  if (selected.some(id => !byId.has(id))) throw new Error('家事カタログの選択を確認してください。');
  const result = new Set(selected);
  if (!enabled) { result.delete(id); return [...result].sort(); }
  if (recipe.splitParentId && recipe.exclusiveWithParent) result.delete(recipe.splitParentId);
  for (const child of PERSONAL_CHORE_CATALOG) if (child.splitParentId === id && child.exclusiveWithParent) result.delete(child.id);
  for (const other of PERSONAL_CHORE_CATALOG) if (recipe.replacesRecipeIds.includes(other.id) || other.replacesRecipeIds.includes(id)) result.delete(other.id);
  result.add(id); return [...result].sort();
}

/** Atomic bulk validation; a single selection replaces its alternatives without another confirmation step. */
export function planPersonalCatalogToggles(selected: readonly string[], ids: readonly string[], enabled: boolean): string[] {
  const foreign = selected.filter(id => !byId.has(id));
  let own = selected.filter(id => byId.has(id));
  const targets = ids.filter(id => byId.has(id));
  for (const id of targets) own = togglePersonalCatalogSelection(own, id, enabled);
  if (enabled && targets.some(id => !own.includes(id))) throw new Error('同じ作業を含む家事は、どちらか一方を選んでください。');
  return [...foreign, ...own];
}
