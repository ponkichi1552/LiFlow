import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, groupId, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createCustomPersonalChore } from '../src/domain/chores/custom-chore.ts';
import { createPersonalChoreDefinitions } from '../src/domain/chores/personal-catalog.ts';
import { standardSharedChores } from '../src/features/sharing/v2/standard-catalog.ts';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import * as copy from '../src/features/sharing/v2/personal-copy.ts';
import * as point from '../src/features/sharing/v2/view-point.ts';
import * as roster from '../src/features/sharing/roster.ts';
import * as choices from '../src/features/settings/group-personal-chore-choices.ts';
import { createGroupChoreSettingsSource } from '../src/features/settings/group-chore-settings-source.ts';

async function setup(userId = 'owner') {
  const family = await fixture(); const d = await family.device(); await d.repository.commit(seeds());
  let ordinal = 0, allowed = true; const reads = [], closes = [];
  const source = { householdId: 'local-household', frequencyMode: 'balanced', chores: [
    createCustomPersonalChore('custom-chore-plants', 'local-household', '植物の水やり', 4, { estimatedMinutes: 8, windowRadiusDays: 1, instructions: ['鉢の土を確認する'] }),
  ], completions: [{ id: 'private-completion' }], googleMapping: 'private-google-mapping' };
  const assertAccess = async () => { if (!allowed) throw new Error('account changed'); };
  const actions = createV2PlannerActions(d.repository, { makeId: () => `choice-action-${++ordinal}`, now });
  const workspace = { userId, groupId, session: { repository: d.repository, controller: { actions } } };
  const module = loadNativeModule('src/platform/sharing/v2-personal-chore-selection.ts', {
    'expo-sqlite': { openDatabaseAsync: async (name, options) => { reads.push({ name, options }); return { closeAsync: async () => closes.push(true) }; } },
    'expo-crypto': { randomUUID: () => `choice-operation-${++ordinal}` },
    '../storage/repository': { readPersonalChoreCopySource: async (_db, ids) => {
      reads.push(ids ? [...ids] : 'definitions');
      return structuredClone({ ...source, chores: source.chores.filter(chore => !ids || ids.includes(chore.id)) });
    } },
    '../../features/sharing/v2/personal-copy': copy,
    '../../features/sharing/v2/view-point': point,
    '../../features/sharing/roster': roster,
    '../../features/settings/group-personal-chore-choices': choices,
  });
  return { d, family, actions, source, reads, closes, workspace, selection: module.createNativeV2PersonalChoreSelection(workspace, assertAccess),
    revoke: () => { allowed = false; }, close: () => d.connection.close() };
}

test('group choices contain missing private definitions unchecked and never duplicate shipped recipes or existing copies', () => {
  const personal = createPersonalChoreDefinitions('local-household');
  const custom = createCustomPersonalChore('custom-chore-plants', 'local-household', '植物の水やり', 4);
  const shared = standardSharedChores('family').map(row => ({ id: row.id, ...row.payload }));
  const available = choices.availablePersonalChoreChoices('owner', 'family', [...personal, custom], shared);
  assert.deepEqual(available.map(row => [row.id, row.enabled]), [[choices.personalChoiceId(custom.id), false]]);
  shared.push({ ...custom, id: choices.sharedPersonalChoiceId('owner', 'family', custom.id), name: '共有側で変更した名前' });
  assert.deepEqual(choices.availablePersonalChoreChoices('owner', 'family', [...personal, custom], shared), []);
  assert.equal(custom.enabled, true);
});

test('reading selectable personal chore definitions never signs changes or loads schedules and closes its private connection', async () => {
  const h = await setup();
  try {
    const before = (await h.d.repository.readState()).replica.operations;
    assert.deepEqual(await h.selection.read(), h.source.chores);
    assert.deepEqual(h.reads, [{ name: 'housework.db', options: { useNewConnection: true } }, 'definitions']);
    assert.equal(h.closes.length, 1);
    assert.deepEqual((await h.d.repository.readState()).replica.operations, before);
    h.source.householdId = 'foreign'; await assert.rejects(h.selection.read(), /本人/u);
    assert.equal(h.closes.length, 2);
  } finally { h.close(); }
});

test('one group checkbox signs a definition and configuration exactly once and excludes all personal history and mappings', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now().getTime() });
  const h = await setup();
  try {
    h.source.chores[0].enabled = false;
    const before = structuredClone(h.source); const initial = (await h.d.repository.readState()).replica.operations.length;
    const id = await h.selection.add(h.source.chores[0].id, true);
    let state = await h.d.repository.readState();
    assert.equal(state.replica.operations.length, initial + 2);
    const saved = state.replica.operations.filter(row => row.entityId === id);
    const definition = saved.find(row => row.entityType === 'chore'); const configuration = saved.find(row => row.entityType === 'chorePolicy');
    assert.deepEqual(saved.map(row => row.entityType).sort(), ['chore', 'chorePolicy']);
    assert.equal(definition.payload.enabled, true); assert.equal(configuration.payload.configuration.active, true);
    assert.equal(configuration.payload.configuration.intervalDays, 4); assert.equal(configuration.payload.configuration.windowBeforeDays, 1);
    const payload = JSON.stringify(saved);
    for (const secret of ['private-completion', 'private-google-mapping', 'custom-chore-plants', 'local-household']) assert.equal(payload.includes(secret), false);
    assert.deepEqual(h.source, before);
    assert.equal(await h.selection.add(h.source.chores[0].id, true), id);
    state = await h.d.repository.readState(); assert.equal(state.replica.operations.length, initial + 2);
    assert.equal(h.closes.length, 2);
  } finally { h.close(); }
});

test('opening an unshared chore creates an inactive group setting and a later checkbox enables that same definition', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now().getTime() }); const h = await setup();
  try {
    const id = await h.selection.add(h.source.chores[0].id, false);
    let state = await h.d.repository.readState(); let at = point.v2ReadPoint(state.assessment.view, state.archive.at(-1));
    assert.equal(state.assessment.view.field('chore', id, 'enabled', at).value, false);
    assert.equal(await h.selection.add(h.source.chores[0].id, true), id);
    state = await h.d.repository.readState(); at = point.v2ReadPoint(state.assessment.view, state.archive.at(-1));
    assert.equal(state.assessment.view.field('chore', id, 'enabled', at).value, true);
    assert.equal(new Set(state.replica.operations.filter(row => row.entityType === 'chore' && row.payload.name === '植物の水やり').map(row => row.entityId)).size, 1);
  } finally { h.close(); }
});

test('personal selection refuses changed accounts, non administrators, missing cycles and ambiguous shared names without extra copies', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now().getTime() });
  for (const mode of ['revoked', 'member', 'cycle', 'ambiguous']) {
    const h = await setup(mode === 'member' ? 'member' : 'owner');
    try {
      if (mode === 'revoked') h.revoke();
      if (mode === 'cycle') h.source.chores[0].requiresCycleSelection = true;
      if (mode === 'ambiguous') await h.d.repository.commit(['duplicate-a', 'duplicate-b'].map(id => ({ operationId: id, entityType: 'chore', entityId: id, operationType: 'patch', payload: { name: h.source.chores[0].name, enabled: false } })));
      const before = (await h.d.repository.readState()).replica.operations;
      await assert.rejects(h.selection.add(h.source.chores[0].id, true), /account changed|管理者|周期|複数/u);
      assert.deepEqual((await h.d.repository.readState()).replica.operations, before);
    } finally { h.close(); }
  }
});

test('the group settings source saves inline choices through its signed source and keeps group settings usable after a private choice read fails', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now().getTime() }); const h = await setup();
  try {
    const record = { userId: 'owner', groupId, status: 'active', localGeneration: 'selection-test' };
    const workspace = { ...h.workspace, protocol: 2, roster: () => h.family.archive.at(-1), record: async () => record };
    let fail = false; let failModel = false; let privateReads = 0;
    const source = createGroupChoreSettingsSource({ ...record }, async () => workspace, { invalidate() {}, readModel: async () => {
      if (failModel) throw new Error('read after commit failed');
      return { viewerUserId: 'owner', adminUserId: 'owner', plan: await h.actions.readPlan({ from: '2026-10-27', through: '2026-10-27', asOfDate: '2026-10-27' }) };
    } },
      () => ({ ...h.selection, read: async () => { privateReads++; if (fail) throw new Error('private metadata unavailable'); return h.selection.read(); } }));
    await source.refresh();
    const selected = source.getSnapshot().snapshot.personalChoices[0].id;
    const { saveEnabled } = source; await saveEnabled([selected], true);
    let value = source.getSnapshot().snapshot;
    assert.equal(value.personalChoices.length, 0); assert.equal(value.model.plan.chores.find(row => row.name === '植物の水やり').enabled, true);
    fail = true; await source.refresh(); value = source.getSnapshot().snapshot;
    assert.ok(value.model.plan.chores.length); assert.match(value.personalChoicesError, /読み込めません/u); assert.equal(source.getSnapshot().error, null);
    const outcome = await source.perform(async () => { await h.actions.addWasteSchedule({ label: 'びん', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 21 }); failModel = true; });
    assert.equal(outcome.committed, true); assert.equal(outcome.refreshed, false);
    const saved = (await h.d.repository.readState()).replica.operations;
    failModel = false; await source.refresh(); assert.deepEqual((await h.d.repository.readState()).replica.operations, saved);
    const previousReads = privateReads; record.userId = 'changed';
    await assert.rejects(saveEnabled([selected], true), /参加状態/u);
    let executed = false; const denied = await source.perform(async () => { executed = true; });
    assert.equal(denied.committed, false); assert.equal(executed, false);
    assert.equal(privateReads, previousReads);
  } finally { h.close(); }
});

for (const platform of ['ios', 'android']) test(`${platform} group settings select a missing personal chore inline and open its group configuration without a separate copy page`, async () => {
  const custom = createCustomPersonalChore('custom-chore-plants', 'local-household', '植物の水やり', 4);
  const navigation = [], writes = []; let release;
  const wait = new Promise(resolve => { release = resolve; });
  const record = { userId: 'owner', groupId: 'family', status: 'active' };
  const value = { workspace: { session: { controller: { actions: {} } } }, model: { viewerUserId: 'owner', adminUserId: 'owner', plan: { chores: [] } }, personalChoices: [{ ...custom, id: choices.personalChoiceId(custom.id), enabled: false }] };
  const source = { saveEnabled: async (ids, enabled) => { writes.push([ids, enabled]); await wait; value.personalChoices = []; value.model.plan.chores = [{ ...custom, id: 'shared-plants', enabled }]; },
    addPersonalChore: async (id, enabled) => { writes.push([id, enabled]); return { id: 'shared-plants', refreshed: true }; }, refresh: async () => {} };
  const props = { group: record };
  const screen = screenHarness('src/features/settings/chore-settings-sources.tsx', { exportName: 'ChoreSettingsSources', platform, props,
    effect: callback => callback(), effectDependencies: true, navigate: (...args) => navigation.push(args), personalData: () => { throw new Error('full personal settings must not load'); }, mocks: {
      '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: 'owner', group: record } } },
      './use-group-chore-settings': { useGroupChoreSettings: () => ({ snapshot: value, source }) },
      '../sharing/v2-ui/waste-screen': { V2WasteScreen: () => null },
    } });
  await screen.press('追加した家事の家事を開く');
  await screen.press('植物の水やりの設定を開く');
  assert.deepEqual(writes, [[choices.personalChoiceId(custom.id), false]]);
  assert.deepEqual(navigation.at(-1), ['push', { pathname: '/settings/chore/[id]', params: { id: 'shared-plants', source: 'shared', groupId: 'family' } }]);
  writes.length = 0; navigation.length = 0;
  const toggle = screen.nodes().find(row => row.props.accessibilityRole === 'checkbox');
  assert.equal(toggle.props.accessibilityState.checked, false);
  toggle.props.onPress(); toggle.props.onPress(); await screen.flush();
  assert.equal(writes.length, 1); assert.equal(screen.nodes().find(row => row.props.accessibilityRole === 'checkbox').props.accessibilityState.checked, true);
  release(); await screen.flush(); await screen.flush();
  await screen.press('植物の水やりの設定を開く');
  assert.deepEqual(navigation.at(-1), ['push', { pathname: '/settings/chore/[id]', params: { id: 'shared-plants', source: 'shared', groupId: 'family' } }]);
  assert.equal(screen.text().includes('個人家事から追加'), false); screen.unmount();
});
