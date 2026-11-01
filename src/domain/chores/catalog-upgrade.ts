import type { ChoreDefinition, ChoreLoad, FrequencyMode } from './types.ts';
import { createLegacyHouseholdChoreDefinitionsV3 } from './catalog-v3.ts';

type ScheduleDefaults = Pick<ChoreDefinition,
  'load' | 'frequencyDaysByMode' | 'windowRadiusDays' | 'maxShiftDays' | 'holidayPriority' | 'everyday'>;

// Frozen version 1/2 defaults, used only to recognize untouched settings during the version 3 upgrade.
// Current catalog defaults must always be specified on each entry in catalog.ts.
const PREVIOUS_CYCLES: Record<ChoreLoad, ChoreDefinition['frequencyDaysByMode']> = {
  heavy: { frequent: 14, balanced: 30, relaxed: 60 },
  normal: { frequent: 7, balanced: 14, relaxed: 30 },
  light: { frequent: 3, balanced: 7, relaxed: 14 },
};

const PREVIOUS_LOADS: Readonly<Record<string, ChoreLoad>> = {
  'builtin-chore-01': 'heavy',
  'builtin-chore-02': 'heavy',
  'builtin-chore-03': 'heavy',
  'builtin-chore-04': 'heavy',
  'builtin-chore-05': 'heavy',
  'builtin-chore-06': 'normal',
  'builtin-chore-07': 'normal',
  'builtin-chore-08': 'normal',
  'builtin-chore-09': 'normal',
  'builtin-chore-10': 'normal',
  'builtin-chore-11': 'light',
  'builtin-chore-12': 'light',
  'builtin-chore-13': 'light',
  'builtin-chore-14': 'light',
  'builtin-chore-15': 'light',
  'builtin-chore-16': 'light',
  'builtin-chore-17': 'normal',
  'builtin-chore-18': 'normal',
  'builtin-chore-19': 'light',
  'builtin-chore-20': 'normal',
};

function previousDefaults(id: string): ScheduleDefaults | undefined {
  const load = PREVIOUS_LOADS[id];
  if (!load) return undefined;
  const everyday = id === 'builtin-chore-11';
  return {
    load,
    frequencyDaysByMode: everyday ? { frequent: 1, balanced: 1, relaxed: 2 } : PREVIOUS_CYCLES[load],
    windowRadiusDays: load === 'heavy' ? 2 : load === 'light' ? 0 : 1,
    maxShiftDays: everyday ? 0 : load === 'heavy' ? 7 : 4,
    holidayPriority: load === 'heavy',
    everyday,
  };
}

/** Upgrade each unchanged default independently, preserving all explicit interval overrides and other user data. */
export function upgradeBuiltInScheduleDefaults(
  existing: ChoreDefinition,
  current: ChoreDefinition,
): { definition: ChoreDefinition; scheduleChanged: boolean } {
  const previous = previousDefaults(existing.id);
  if (!previous || existing.id !== current.id) return { definition: existing, scheduleChanged: false };

  const upgradeMode = (mode: FrequencyMode) => existing.frequencyDaysByMode[mode] === previous.frequencyDaysByMode[mode]
    ? current.frequencyDaysByMode[mode]
    : existing.frequencyDaysByMode[mode];
  const definition: ChoreDefinition = {
    ...existing,
    frequencyDaysByMode: { frequent: upgradeMode('frequent'), balanced: upgradeMode('balanced'), relaxed: upgradeMode('relaxed') },
    load: existing.load === previous.load ? current.load : existing.load,
    windowRadiusDays: existing.windowRadiusDays === previous.windowRadiusDays ? current.windowRadiusDays : existing.windowRadiusDays,
    maxShiftDays: existing.maxShiftDays === previous.maxShiftDays ? current.maxShiftDays : existing.maxShiftDays,
    holidayPriority: existing.holidayPriority === previous.holidayPriority ? current.holidayPriority : existing.holidayPriority,
    everyday: existing.everyday === previous.everyday ? current.everyday : existing.everyday,
  };
  const scheduleChanged = definition.load !== existing.load
    || definition.windowRadiusDays !== existing.windowRadiusDays
    || definition.maxShiftDays !== existing.maxShiftDays
    || definition.holidayPriority !== existing.holidayPriority
    || definition.everyday !== existing.everyday
    || (['frequent', 'balanced', 'relaxed'] as const).some((mode) => definition.frequencyDaysByMode[mode] !== existing.frequencyDaysByMode[mode]);
  return { definition, scheduleChanged };
}

const legacyById = new Map(createLegacyHouseholdChoreDefinitionsV3('catalog-upgrade').map(chore => [chore.id, chore]));
export const BUILT_IN_GUIDE_FIELDS = ['name', 'category', 'description', 'locationOrAppliance', 'estimatedMinutes', 'instructions',
  'procedureSections', 'tools', 'cautions', 'trivia', 'sourceNotes', 'schedulingNotes', 'laundryDryingPreference'] as const;
const scheduleFields = ['load', 'windowRadiusDays', 'maxShiftDays', 'holidayPriority', 'everyday'] as const;
const same = (a: unknown, b: unknown): boolean => {
  if (a === b || a == null && b == null) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
};

/** Only fields that still equal the old shipped value may follow the document update. */
export function builtInCatalogPatch(existing: Record<string, unknown>, current: ChoreDefinition): Record<string, unknown> {
  const match = /(?:^|\.)(builtin-chore-\d{2})$/u.exec(current.id);
  const previous = match ? legacyById.get(match[1]) : undefined;
  if (!previous || existing.applianceId || existing.applianceCareSource) return {};
  const patch: Record<string, unknown> = {};
  for (const field of [...BUILT_IN_GUIDE_FIELDS, ...scheduleFields]) {
    if (same(existing[field], previous[field]) && !same(existing[field], current[field])) patch[field] = current[field];
  }
  const oldModes = previous.frequencyDaysByMode;
  const modes = existing.frequencyDaysByMode as ChoreDefinition['frequencyDaysByMode'] | undefined;
  if (modes && typeof modes === 'object') {
    const next = { ...modes };
    for (const mode of ['frequent', 'balanced', 'relaxed'] as const) if (modes[mode] === oldModes[mode]) next[mode] = current.frequencyDaysByMode[mode];
    if (!same(modes, next)) patch.frequencyDaysByMode = next;
  }
  return patch;
}

export function upgradeBuiltInCatalogDefinition(existing: ChoreDefinition, current: ChoreDefinition, previousVersion: number) {
  const frozen = legacyById.get(existing.id);
  const intermediate = previousVersion < 3 && frozen ? upgradeBuiltInScheduleDefaults(existing, { ...frozen, householdId: existing.householdId }).definition : existing;
  const definition: ChoreDefinition = { ...intermediate, ...builtInCatalogPatch(intermediate as unknown as Record<string, unknown>, current) };
  const scheduleChanged = [...scheduleFields, 'frequencyDaysByMode' as const].some(field => !same(existing[field], definition[field]));
  return { definition, scheduleChanged };
}
