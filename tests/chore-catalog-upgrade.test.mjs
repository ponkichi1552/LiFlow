import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { createLegacyHouseholdChoreDefinitionsV3: createHouseholdChoreDefinitions } = await import('../src/domain/chores/catalog-v3.ts');
const { upgradeBuiltInScheduleDefaults } = await import('../src/domain/chores/catalog-upgrade.ts');

const expected = [
  ['heavy',3,7,14,2], ['heavy',60,90,180,14], ['normal',3,7,14,2], ['heavy',30,90,180,14],
  ['heavy',14,30,60,7], ['normal',3,7,14,1], ['light',3,7,14,1], ['normal',3,7,14,2],
  ['normal',4,7,14,2], ['normal',1,2,3,1], ['light',1,1,1,0], ['light',1,1,1,0],
  ['light',1,1,1,0], ['light',3,7,14,2], ['light',3,7,14,2], ['light',1,1,1,0],
  ['normal',14,30,60,7], ['normal',14,30,60,7], ['light',30,60,90,14], ['normal',30,60,90,14],
];
test('the frozen version 3 catalog retains its 20 historical schedules for safe migrations', () => {
  const chores = createHouseholdChoreDefinitions('home');
  assert.deepEqual(chores.map((chore) => [chore.load, ...['frequent','balanced','relaxed'].map((mode) => chore.frequencyDaysByMode[mode]), chore.windowRadiusDays]), expected);
  assert.deepEqual(chores.flatMap((chore,index) => chore.everyday ? [index+1] : []), [11,12,13,16]);
  for (const chore of chores.filter((item) => item.everyday)) assert.equal(chore.maxShiftDays, 0);
});

test('catalog upgrade replaces only matching defaults and retains explicit intervals and independent edits', () => {
  const current = createHouseholdChoreDefinitions('home')[0];
  const previous = { ...current, enabled: false, load: 'heavy', windowRadiusDays: 2, maxShiftDays: 7, holidayPriority: true,
    frequencyDaysByMode: { frequent: 14, balanced: 30, relaxed: 60 }, recommendedCycleDays: 30, userIntervalDays: 17 };
  const upgrade = upgradeBuiltInScheduleDefaults(previous, current);
  assert.deepEqual(upgrade.definition.frequencyDaysByMode, { frequent: 3, balanced: 7, relaxed: 14 });
  assert.equal(upgrade.definition.recommendedCycleDays, 30);
  assert.equal(upgrade.definition.userIntervalDays, 17);
  assert.equal(upgrade.definition.enabled, false);
  const custom = { ...previous, load: 'light', windowRadiusDays: 5,
    frequencyDaysByMode: { frequent: 23, balanced: 30, relaxed: 47 } };
  const preserved = upgradeBuiltInScheduleDefaults(custom, current).definition;
  assert.deepEqual(preserved.frequencyDaysByMode, { frequent: 23, balanced: 7, relaxed: 47 });
  assert.equal(preserved.load, 'light'); assert.equal(preserved.windowRadiusDays, 5);
});

test('catalog default upgrade does not touch an appliance-generated chore', () => {
  const current = createHouseholdChoreDefinitions('home')[0];
  const appliance = { ...current, id: 'appliance-care-task', applianceId: 'appliance' };
  assert.deepEqual(upgradeBuiltInScheduleDefaults(appliance, appliance), { definition: appliance, scheduleChanged: false });
});
