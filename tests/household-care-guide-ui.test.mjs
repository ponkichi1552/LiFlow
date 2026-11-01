import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createHouseholdChoreDefinitions, HOUSEHOLD_CARE_IDS } from '../src/domain/chores/catalog.ts';
import { HOUSEHOLD_CARE_GUIDE } from '../src/domain/chores/household-care-guide.ts';

for (const platform of ['ios', 'android']) {
  test(`${platform} a directly opened guide document and library reveal their laid-out content without requiring the home screen first`, () => {
    const chores = createHouseholdChoreDefinitions('local-household').slice(0, 1);
    for (const [file, exportName, path, props] of [
      ['src/components/chore-book.tsx', 'ChoreBook', '../platform/diagnostics/startup-splash', { chores, selectedId: chores[0].id, title: '家事の説明', renderChore: chore => chore.description, onBack() {} }],
      ['src/features/chores/chore-library.tsx', 'ChoreLibrary', '../../platform/diagnostics/startup-splash', { chores, onOpen() {} }],
    ]) {
      let revealed = 0;
      const screen = screenHarness(file, { exportName, platform, props, mocks: { [path]: { finishStartupDisplay: () => { revealed++; } } } });
      assert.equal(revealed, 0);
      const surface = screen.nodes().find(node => typeof node.props.onLayout === 'function');
      assert.ok(surface, `${exportName} must release the native splash when its own surface is ready`);
      surface.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } });
      assert.equal(revealed, 1);
    }
  });
  test(`${platform} all 36 guides render the document cadence conditions and fixed table minutes`, () => {
    const catalog = createHouseholdChoreDefinitions('local-household');
    for (const [index, source] of HOUSEHOLD_CARE_GUIDE.entries()) {
      const chore = catalog.find(row => row.id === HOUSEHOLD_CARE_IDS[index]);
      const screen = screenHarness('src/features/chores/chore-guide.tsx', { exportName: 'ChoreGuide', platform, props: { chore, mode: 'balanced' } });
      const text = screen.text();
      assert.ok(text.includes(source.name)); assert.ok(text.includes(source.description));
      assert.ok(text.includes(source.frequency)); if (source.conditions) assert.ok(text.includes(source.conditions));
      assert.ok(text.includes(`目安 約${source.estimatedMinutes}分`));
      for (const step of source.instructions) assert.ok(text.includes(step), `${source.number} retains every instruction`);
    }
  });
  test(`${platform} a cadence-free guide opens its configuration before any enable write and respects read-only access`, async () => {
    let configured = 0; let saves = 0;
    const props = { name: '暖房器具の使用前点検', enabled: false, requiresCycleSelection: true,
      onConfigure: () => { configured++; }, save: async () => { saves++; } };
    const screen = screenHarness('src/features/chores/chore-plan-toggle.tsx', { exportName: 'ChorePlanToggle', platform, props });
    screen.nodes().find(node => node.type === 'Switch').props.onValueChange(true); await screen.flush();
    assert.equal(configured, 1); assert.equal(saves, 0); assert.equal(screen.nodes().find(node => node.type === 'Switch').props.value, false);
    props.readOnly = true; screen.render();
    screen.nodes().find(node => node.type === 'Switch').props.onValueChange(true); await screen.flush();
    assert.equal(configured, 1); assert.equal(saves, 0);
  });
}
