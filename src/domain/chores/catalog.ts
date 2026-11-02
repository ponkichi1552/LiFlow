import type { ChoreDefinition, ChoreLoad } from './types';
import { HOUSEHOLD_CARE_GUIDE } from './household-care-guide.ts';
import { createLegacyHouseholdChoreDefinitionsV3 } from './catalog-v3.ts';

type CatalogEntry = Omit<ChoreDefinition, 'householdId' | 'enabled'>;
export const BUILT_IN_CHORE_CATALOG_VERSION = 5;
const old = createLegacyHouseholdChoreDefinitionsV3('catalog-comparison');
const originallyEnabled = new Set(old.filter(entry => entry.enabled).map(entry => entry.id));
/** Preserve the identity of the same job; never reuse a removed job's ID for a different one. */
export const HOUSEHOLD_CARE_IDS = [21, 2, 1, 7, 6, 8, 4, 15, 5, 10, 9, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46].map(n => `builtin-chore-${String(n).padStart(2, '0')}`);
/** Numeric initial values stay inside the document's stated ranges. null means no fixed cadence is specified. */
const cycles: readonly (readonly [number, number, number] | null)[] = [
  [7, 7, 7], [30, 60, 90], [7, 7, 7], [7, 7, 7], [7, 7, 7], [3, 4, 7], [180, 180, 365], [7, 10, 14], [30, 30, 30],
  [2, 2, 3], [7, 10, 14], [7, 7, 7], [30, 30, 30], [7, 7, 7], [7, 7, 7], [1, 1, 1], [30, 30, 30], [14, 14, 14], [30, 60, 90],
  [30, 45, 60], [3, 7, 14], [14, 14, 14], [30, 30, 30], [60, 75, 90], [10, 20, 30], [7, 7, 7], [60, 90, 180], [7, 7, 7], [180, 180, 180],
  [1, 1, 1], [7, 14, 30], [180, 180, 180], [30, 30, 30], [30, 30, 30], null, [180, 365, 365],
];
const provisional = new Set([16, 21, 27, 31, 36]);
const current = HOUSEHOLD_CARE_GUIDE.map((guide, index): CatalogEntry => {
  const id = HOUSEHOLD_CARE_IDS[index]; const prior = old.find(entry => entry.id === id);
  const cycle = cycles[index]; const everyday = Boolean(cycle?.every(days => days === 1));
  const load: ChoreLoad = prior?.load ?? (guide.estimatedMinutes > 35 ? 'heavy' : guide.estimatedMinutes > 15 ? 'normal' : 'light');
  return {
    id, name: guide.name, category: guide.category, description: guide.description,
    // A serializable positive placeholder is never scheduled or displayed as a cadence while selection is required.
    frequencyDaysByMode: { frequent: cycle?.[0] ?? 1, balanced: cycle?.[1] ?? 1, relaxed: cycle?.[2] ?? 1 },
    requiresCycleSelection: !cycle, everyday,
    windowRadiusDays: !cycle || everyday ? 0 : prior?.windowRadiusDays ?? Math.min(14, Math.max(1, Math.floor(cycle[1] / 5))),
    maxShiftDays: !cycle || everyday ? 0 : prior?.maxShiftDays ?? (load === 'heavy' ? 7 : 4),
    load, holidayPriority: load === 'heavy', locationOrAppliance: prior?.locationOrAppliance ?? guide.name,
    ...([10, 11].includes(guide.number) ? { laundryDryingPreference: 'either' as const } : {}),
    estimatedMinutes: guide.estimatedMinutes, tools: [guide.tools], instructions: [...guide.instructions],
    cautions: guide.cautions.match(/[^。]+。?/gu) ?? [guide.cautions],
    ...(guide.trivia ? { trivia: [{ id: `household-care-${guide.number}`, title: `${guide.name}のポイント`, body: guide.trivia }] } : {}),
    schedulingNotes: [provisional.has(guide.number) ? '仮の周期です。製品・使用条件に合わせて変更してください。' : '', guide.frequency, guide.conditions].filter(Boolean).join('\n'), sourceNotes: [],
  };
});
const used = new Set(HOUSEHOLD_CARE_IDS);
/** Explicitly retired by the user; these jobs and their private history must not return. */
export const RETIRED_BUILT_IN_CHORE_IDS = old.filter(entry => !used.has(entry.id)).map(entry => entry.id);
export function isRetiredBuiltInChore(id: string) { return RETIRED_BUILT_IN_CHORE_IDS.some(retired => id === retired || id.endsWith(`.${retired}`)); }
export const CHORE_CATALOG: readonly CatalogEntry[] = current;
const byId = new Map(CHORE_CATALOG.map(entry => [entry.id, entry]));
const orderById = new Map(CHORE_CATALOG.map((entry, index) => [entry.id, index]));
export function compareBuiltInChoreOrder(a: Pick<ChoreDefinition, 'id'>, b: Pick<ChoreDefinition, 'id'>): number {
  const id = (value: string) => /(?:^|\.)(builtin-chore-\d{2})$/u.exec(value)?.[1];
  return (orderById.get(id(a.id) ?? '') ?? Number.MAX_SAFE_INTEGER) - (orderById.get(id(b.id) ?? '') ?? Number.MAX_SAFE_INTEGER);
}
const oldNames = new Map(old.flatMap(entry => {
  const updated = current.find(candidate => candidate.id === entry.id);
  return updated ? [[entry.name.normalize('NFKC').trim(), updated.name] as const] : [];
}));
/** Exact shipped renames only; an edited or ambiguous household chore is not guessed from keywords. */
export function canonicalBuiltInChoreName(name: string): string {
  const key = name.normalize('NFKC').trim(); return oldNames.get(key) ?? key;
}
export function builtInChoreCatalogEntry(id: string): CatalogEntry | undefined {
  const match = /(?:^|\.)(builtin-chore-\d{2})$/u.exec(id);
  return match ? byId.get(match[1]) : undefined;
}
export function createHouseholdChoreDefinitions(householdId: string): ChoreDefinition[] {
  return CHORE_CATALOG.map(entry => ({ ...entry, householdId, enabled: originallyEnabled.has(entry.id) && !entry.requiresCycleSelection }));
}
