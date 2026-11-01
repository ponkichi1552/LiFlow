import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
for (const platform of ['ios', 'android']) test(`${platform} a saved mutation does not claim its stale refresh was displayed after leaving`, async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const c = createV2GroupController(d.repository, { makeId: () => 'unused', now, sync: async () => {} });
  const value = await c.readModel({ from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' });
  let held = false; let focus; const entered = deferred(); const release = deferred();
  const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { platform, exportName: 'V2GroupScreen', focusEffect: callback => { focus = callback; },
    props: { purpose: 'workspace', view: 'waste', loadSession: async () => ({ controller: c, readModel: async () => {
      if (held) { entered.resolve(); await release.promise; } return value;
    } }), onBack() {} }, mocks: { './waste-screen': { V2WasteScreen: props => ({ type: 'CapturedWaste', props }) } } });
  const leave = focus(); for (let n = 0; n < 15 && !screen.nodes().some(node => node.type === 'CapturedWaste'); n++) await screen.flush();
  held = true; const pending = screen.nodes().find(node => node.type === 'CapturedWaste').props.perform(async () => {});
  await entered.promise; leave(); release.resolve();
  assert.deepEqual(await pending, { committed: true, refreshed: false }); screen.unmount();
});
async function setup(platform, failWithoutError = false) {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds()); let n = 0; let listener; let reads = 0; let hold = null;
  const c = createV2GroupController(d.repository, { makeId: () => `refresh-${++n}`, now, sync: async () => {} });
  const decorated = { ...c, actions: { ...c.actions, complete: async (...args) => { if (failWithoutError) throw null; const result = await c.actions.complete(...args); listener?.(); listener?.(); return result; } } };
  const source = createV2ScreenSession({ controller: decorated, groupId, userId: 'owner', now,
    readPreferences: () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
  const session = { ...source, readModel: async options => { reads++; const model = await source.readModel(options);
    if (hold) { const current = hold; hold = null; current.entered.resolve(); await current.release.promise; } return model; } };
  let focus;
  const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
    props: { purpose: 'workspace', view: 'home', loadSession: async () => session, subscribe: callback => { listener = callback; return () => { listener = null; }; }, onBack() {}, onConfiguration() {}, onHistory() {} },
    focusEffect: callback => { focus = callback; } });
  const leave = focus(); for (let n = 0; n < 25 && !screen.text().includes('床を掃除する'); n++) await screen.flush();
  assert.match(screen.text(), /床を掃除する/u);
  return { d, c, screen, reads: () => reads, notify: () => listener?.(), holdNext: value => { hold = value; }, close: () => { leave(); d.connection.close(); } };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} a mutation that throws a non-Error value remains failed and cannot be displayed as a successful completion`, async () => {
    const f = await setup(platform, true);
    try {
      await f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox').props.onPress(); await f.screen.flush();
      assert.match(f.screen.text(), /操作を完了できませんでした/u); assert.equal(f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox').props.accessibilityState.checked, false);
      assert.equal(f.d.connection.prepare("SELECT COUNT(*) AS n FROM sharing_operations WHERE json_extract(operation_json, '$.entityType')=?").get('completion').n, 0);
    } finally { f.close(); }
  });
  test(`${platform} mutation reads coalesce their own change notifications instead of rereading the same committed state`, async () => {
    const f = await setup(platform);
    try {
      await f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox').props.onPress(); await f.screen.flush();
      await new Promise(resolve => setTimeout(resolve, 120)); await f.screen.flush();
      assert.equal(f.reads(), 2); assert.equal(f.d.connection.prepare("SELECT COUNT(*) AS n FROM sharing_operations WHERE json_extract(operation_json, '$.entityType')=?").get('completion').n, 1);
    } finally { f.close(); }
  });
  test(`${platform} a change arriving during a mutation read is refreshed once afterward instead of being silently dropped`, async () => {
    const f = await setup(platform); const entered = deferred(); const release = deferred();
    try {
      f.holdNext({ entered, release }); const pending = f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox').props.onPress(); await entered.promise;
      await f.c.actions.patchChore('floor', { name: '再読込中に届いた家事名' }); f.notify(); f.notify();
      await new Promise(resolve => setTimeout(resolve, 120)); release.resolve(); await pending;
      for (let n = 0; n < 30 && !f.screen.text().includes('再読込中に届いた家事名'); n++) await f.screen.flush();
      assert.match(f.screen.text(), /再読込中に届いた家事名/u); assert.equal(f.reads(), 3);
      assert.equal(f.d.connection.prepare("SELECT COUNT(*) AS n FROM sharing_operations WHERE json_extract(operation_json, '$.entityType')=?").get('completion').n, 1);
    } finally { release.resolve(); f.close(); }
  });
}
