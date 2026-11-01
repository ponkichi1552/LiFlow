import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { plannerColorsForScheme } from '../src/components/planner-theme.ts';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { sharedGroupBootstrap } from '../src/features/sharing/planning.ts';
import { createLocalSharedOperations, initializeSharingLedger, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { createSharedPlannerRepository } from '../src/platform/storage/shared-planner-repository.ts';
import { registerSharedRepositoryAdapter } from '../src/platform/storage/shared-repository-adapter.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
const repository = await import('../src/platform/storage/repository.ts');
const { createGroupChoreSettingsSource } = await import('../src/features/settings/group-chore-settings-source.ts');
const today = new Date().toISOString().slice(0, 10);
async function legacyFixture() {
  // The public settings source now supports v2 only; original personal SQLite remains separate.
  const native = await workspaceHarness({ deferWorkspaceTimers: true }); const personal = createDatabase();
  await repository.initializeLocalDatabase(personal.database);
  const opened = await native.api.openSharedWorkspace(native.record);
  const record = { ...native.record, status: 'active', displayName: '家族', localGeneration: undefined };
  const scope = { userId: record.userId, groupId: record.groupId, householdId: 'shared-v2' };
  const workspace = { ...opened, record: async () => { if (native.auth.uid !== scope.userId) throw new Error('account changed'); return { ...record }; } };
  const model = await opened.session.controller.readModel({ from: today, through: today, asOfDate: today });
  for (const chore of model.plan.chores) await opened.session.controller.actions.configureChore(chore.id, { policy: chorePolicyFromPreset('common'),
    anchorDate: today, effectiveFrom: today, intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, active: false });
  await opened.session.repository.commit([{ operationId: 'settings-name', entityType: 'settings', entityId: 'settings', operationType: 'patch', payload: { name: '家族' } }]);
  const source = createGroupChoreSettingsSource(scope, async () => workspace); await source.refresh();
  let snapshot = await repository.loadPlannerSnapshot(personal.database, today);
  const personalData = { database: personal.database, loading: false, error: null, snapshot, readError: () => null,
    refresh: async () => { snapshot = await repository.loadPlannerSnapshot(personal.database, today); personalData.snapshot = snapshot; } };
  const shared = native.handles.find(handle => handle.database === opened.database);
  return { shared, personal, scope, record, workspace, source, personalData, account: value => { native.auth.uid = value; },
    close: async () => { personal.connection.close(); await native.close(); } };
}
const definitions = h => h.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_v2_binding'").get()
  ? h.connection.prepare('SELECT operation_id,operation_json FROM sharing_operations ORDER BY operation_id').all()
  : h.connection.prepare('SELECT id,enabled,definition_json FROM chore_definitions ORDER BY id').all();
const allNodes = tree => tree.flatMap(node => typeof node === 'string' ? [] : [node, ...allNodes(node.children ?? [])]);

test('group management settings never load or offer the personal settings source', async () => {
  const f = await legacyFixture();
  try {
    const screen = screenHarness('src/features/settings/chore-settings-sources.tsx', { exportName: 'ChoreSettingsSources', props: { first: 'group', group: f.record },
      personalData: () => { throw new Error('group management must not read personal settings'); }, mocks: {
        '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: f.scope.userId, group: f.record } } },
        './use-group-chore-settings': { useGroupChoreSettings: () => ({ ...f.source.getSnapshot(), source: f.source }) },
      } });
    assert.equal(screen.text().includes('個人用'), false); screen.button(`${f.source.getSnapshot().snapshot.model.plan.chores[0].category}の見出しを展開`);
  } finally { await f.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} chore settings order personal first in Settings and group first in Group with independent saves`, async () => {
    const f = await legacyFixture(); const navigation = [];
    try {
      const context = { userId: f.scope.userId, active: f.workspace, group: f.record };
      for (const first of ['personal', 'group']) {
        const screen = screenHarness('src/features/settings/chore-settings-sources.tsx', { exportName: 'ChoreSettingsSources', platform, props: { first },
          personalData: () => f.personalData, navigate: (...args) => navigation.push(args), mocks: {
            '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: context } },
            './use-group-chore-settings': { useGroupChoreSettings: () => ({ ...f.source.getSnapshot(), source: f.source }) },
          } });
        const personalPosition = screen.text().indexOf('個人用'), groupPosition = screen.text().indexOf('グループ用 · 家族');
        assert.equal(personalPosition < groupPosition, first === 'personal'); assert.equal(screen.text().includes('left-group'), false);
        const chores = first === 'personal' ? f.personalData.snapshot.chores : f.source.getSnapshot().snapshot.model.plan.chores;
        const chore = chores.find(row => !row.archived);
        await screen.press(`${chore.category}の見出しを展開`);
        const toggle = screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === `${chore.name}を有効にする`);
        const privateBefore = definitions(f.personal), sharedBefore = definitions(f.shared), outbox = await listSharingOutbox(f.shared.database, f.scope.groupId);
        const queuedBefore = f.shared.connection.prepare('SELECT COUNT(*) AS n FROM sharing_outbox').get().n;
        toggle.props.onValueChange(!toggle.props.value);
        const deadline = Date.now() + 2000;
        do { await new Promise(resolve => setTimeout(resolve, 5)); await screen.flush(); }
        while (Date.now() < deadline && screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === `${chore.name}を有効にする`)?.props.disabled);
        if (first === 'personal') {
          assert.notDeepEqual(definitions(f.personal), privateBefore); assert.deepEqual(definitions(f.shared), sharedBefore);
          assert.deepEqual(await listSharingOutbox(f.shared.database, f.scope.groupId), outbox);
        } else {
          assert.notDeepEqual(definitions(f.shared), sharedBefore); assert.deepEqual(definitions(f.personal), privateBefore);
          assert.ok(f.shared.connection.prepare('SELECT COUNT(*) AS n FROM sharing_outbox').get().n > queuedBefore);
          assert.ok((await listSharingOutbox(f.shared.database, f.scope.groupId)).length <= 100, 'the public outbox read remains one bounded page');
        }
        await screen.press(`${chore.name}の個別設定`);
        assert.deepEqual(navigation.at(-1), ['push', first === 'personal'
          ? { pathname: '/settings/chore/[id]', params: { id: chore.id, source: 'personal' } }
          : { pathname: '/sharing/chore-settings/[id]', params: { id: chore.id, groupId: f.scope.groupId } }]);
      }
    } finally { await f.close(); }
  });

  test(`${platform} connected editors show one fixed audience and personal edits keep the current group untouched`, async () => {
    const f = await legacyFixture();
    try {
      const chore = f.personalData.snapshot.chores[0], before = definitions(f.shared);
      const screen = screenHarness('src/app/settings/chore/[id].tsx', { platform, params: { id: chore.id, source: 'personal' },
        database: f.shared.database, snapshot: () => f.source.getSnapshot().snapshot.model.plan, personalData: () => f.personalData,
        mocks: { '../contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: f.scope.userId, group: f.record } } } } });
      assert.equal(screen.text().split('個人用').length - 1, 1); assert.equal(screen.text().includes('グループ用'), false);
      await screen.change('家事周期の日数', '17'); await screen.endEditing('家事周期の日数'); for (let i = 0; i < 4; i++) await screen.flush();
      assert.equal(f.personalData.snapshot.chores.find(row => row.id === chore.id).recommendedCycleDays, 17);
      assert.deepEqual(definitions(f.shared), before);
      const value = f.source.getSnapshot().snapshot;
      assert.equal(value.protocol, 2); assert.equal(value.record.displayName, '家族');
      assert.equal(value.workspace.adapter, undefined);
      assert.equal(value.model.plan.chores.length, 46);

    } finally { await f.close(); }
  });

  test(`${platform} individual switches remain accessible while categories show only the enabled count and expansion`, async () => {
    const props = { value: false, accessibilityLabel: '切り替え', onValueChange() {} };
    const screen = screenHarness('src/components/settings-switch.tsx', { exportName: 'SettingsSwitch', platform, props });
    const toggle = screen.nodes().find(node => node.type === 'Switch');
    assert.equal(toggle.props.ios_backgroundColor, undefined); assert.equal(toggle.props.style[0].width, undefined); assert.equal(toggle.props.style[0].height, undefined);
    if (platform === 'ios') assert.equal(toggle.props.thumbColor, undefined);
    if (platform === 'android') {
      const palette = plannerColorsForScheme('dark');
      const dark = screenHarness('src/components/settings-switch.tsx', { exportName: 'SettingsSwitch', platform, props,
        mocks: { './planner-colors': { palette } } });
      const grip = dark.nodes().find(node => node.type === 'Switch');
      const luminance = color => {
        const values = color.slice(1).match(/../gu).map(value => parseInt(value, 16) / 255)
          .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const a = luminance(grip.props.thumbColor), b = luminance(palette.surface);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 3, 'Android switch grip must remain visible against the dark surface');
      assert.equal(grip.props.onValueChange, props.onValueChange);
      assert.equal(grip.props.value, props.value);
    }
    const rows = [{ id: 'a', name: '家事', category: '分類', enabled: false }];
    const list = screenHarness('src/features/settings/chore-toggle-list.tsx', { exportName: 'ChoreToggleList', platform, props: {
      chores: rows, expanded: new Set(['分類']), setExpanded() {}, onOpen() {}, save: async () => {} } });
    assert.equal(list.nodes().filter(node => node.type === 'Switch').length, 1);
    for (const label of ['分類の家事をすべて無効にする', '分類の有効な家事を個別に選ぶ', '分類の家事をすべて有効にする']) assert.throws(() => list.button(label), /missing button/u);
    assert.ok(list.text().includes('0/1')); list.button('分類の見出しを折りたたむ');
  });

  test(`${platform} category rail scrubs by measured position clamps the ends and preserves accessible taps`, async () => {
    const selected = [], states = [], effects = []; const groups = ['水回り', 'キッチン', '居室'].map((name, i) => ({ name,
      chores: [0, 1].map(offset => ({ id: `chore-${i * 2 + offset}`, name: `家事${i * 2 + offset}` })) }));
    const screen = screenHarness('src/components/chore-category-rail.tsx', { exportName: 'ChoreCategoryRail', platform,
      layoutEffect: callback => effects.push(callback), props: { groups, category: '水回り', selectedId: 'chore-0', onSelect: id => selected.push(id), onScrubChange: active => states.push(active) } });
    effects.splice(0).forEach(callback => callback());
    const root = screen.nodes().find(node => node.type === 'View' && node.props.onPanResponderGrant);
    screen.render(); assert.equal(screen.nodes().find(node => node.props.onPanResponderGrant).props.ref, root.props.ref, 'rerender must not detach the active native gesture');
    root.props.ref({ measureInWindow: callback => callback(10, 200, 40, 300) });
    assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'button').length, 9, 'short chore ticks accompany category marks');
    assert.equal(root.props.onMoveShouldSetPanResponderCapture({}, { dy: 2, numberActiveTouches: 1 }), false);
    assert.equal(root.props.onMoveShouldSetPanResponderCapture({}, { dy: 8, numberActiveTouches: 2 }), false);
    root.props.onPanResponderGrant({ nativeEvent: { pageY: 250 } }, { moveY: 250 });
    for (const moveY of [251, 280, 335, 336, 385, 1000, 999, 20]) root.props.onPanResponderMove({}, { moveY, numberActiveTouches: 1 });
    root.props.onPanResponderMove({}, { moveY: 335, numberActiveTouches: 2 }); root.props.onPanResponderRelease();
    assert.deepEqual(selected, ['chore-0', 'chore-1', 'chore-2', 'chore-3', 'chore-5', 'chore-0']); assert.deepEqual(states, [true, false]);
    await screen.press('居室の先頭へ移動'); assert.equal(selected.at(-1), 'chore-4');
    await screen.press('家事5へ移動'); assert.equal(selected.at(-1), 'chore-5');
    root.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); assert.equal(selected.at(-1), 'chore-1');
  });
}

test('named group settings reject account and membership changes or a different returned group without touching private data', async () => {
  const f = await legacyFixture();
  try {
    const before = definitions(f.personal); const chore = f.source.getSnapshot().snapshot.model.plan.chores[0];
    f.account('another'); await assert.rejects(f.source.saveEnabled([chore.id], false), /account changed/u);
    await f.source.refresh(); assert.equal(f.source.getSnapshot().snapshot, null);
    f.account(f.scope.userId); f.record.status = 'left'; await assert.rejects(f.source.saveEnabled([chore.id], false), /参加状態/u);
    f.record.status = 'active'; f.record.localGeneration = 'rejoined'; await assert.rejects(f.source.saveEnabled([chore.id], false), /参加状態/u);
    const foreign = createGroupChoreSettingsSource({ ...f.scope, groupId: 'different' }, async () => f.workspace);
    await foreign.refresh(); assert.equal(foreign.getSnapshot().snapshot, null); assert.match(foreign.getSnapshot().error, /共有グループ/u);
    assert.deepEqual(definitions(f.personal), before);
  } finally { await f.close(); }
});

test('group editor targets the current membership while keeping personal settings independent', async () => {
  const f = await legacyFixture(); const effects = []; let selected = 0, props;
  try {
    const chore = f.source.getSnapshot().snapshot.model.plan.chores[0], before = definitions(f.personal);
    const context = { userId: f.scope.userId, active: f.workspace, group: f.record, switchTo: () => { selected++; } };
    const screen = screenHarness('src/app/sharing/chore-settings/[id].tsx', { params: { id: chore.id, groupId: f.scope.groupId }, effect: callback => effects.push(callback), mocks: {
      '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: context } },
      '@/platform/sharing/workspaces': { openSharedWorkspace: async selection => { assert.equal(selection.groupId, f.scope.groupId); return f.workspace; } },
      '../sharing/v2-ui/group-screen': { V2GroupScreen: value => { props = value; return 'named-v2-editor'; } },
    } });
    effects.splice(0).forEach(callback => callback()); for (let i = 0; i < 4; i++) await screen.flush();
    assert.equal(props.choreId, chore.id); assert.equal(props.view, 'details');
    const session = await props.loadSession(); const model = await session.readModel();
    assert.equal(model.plan.groupId, f.scope.groupId); assert.equal(model.personal, undefined);
    const configuration = model.configurations.find(row => row.choreId === chore.id).configuration;
    await session.controller.actions.patchChoreConfiguration(chore.id, configuration.ruleVersion, { intervalDays: 19 }, today);
    const changed = await session.readModel(); assert.equal(changed.configurations.find(row => row.choreId === chore.id).configuration.intervalDays, 19);
    assert.deepEqual(definitions(f.personal), before); assert.equal(selected, 0);
  } finally { await f.close(); }
});

test('settings history links preserve the explicit personal or current group source', async () => {
  const f = await legacyFixture(); const navigation = []; let historyProps;
  try {
    const personal = f.personalData.snapshot.chores[0], shared = f.source.getSnapshot().snapshot.model.plan.chores[0];
    const own = screenHarness('src/app/settings/chore/[id].tsx', { params: { id: personal.id, source: 'personal' },
      personalData: () => f.personalData, navigate: (...args) => navigation.push(args) });
    await own.press('この家事の履歴を見る');
    assert.deepEqual(navigation.at(-1), ['push', { pathname: '/history', params: { choreId: personal.id, source: 'personal' } }]);
    f.personalData.snapshot = { ...f.personalData.snapshot, chores: [{ ...personal, id: shared.id, name: '別領域にある同じIDの個人家事' }] };
    const history = screenHarness('src/app/sharing/history.tsx', { params: { groupId: f.scope.groupId, choreId: shared.id }, personalData: () => f.personalData,
      snapshot: () => f.personalData.snapshot, mocks: {
        '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: f.scope.userId, active: f.workspace, group: f.record } } },
        './group-chore-settings-screen': { SelectedGroupChoreSettings: props => { historyProps = props; return 'named-v2-history'; } },
      } });
    assert.equal(historyProps.groupId, f.scope.groupId); assert.equal(historyProps.choreId, shared.id); assert.equal(historyProps.initialView, 'history');
    assert.equal(history.text().includes('別領域にある同じIDの個人家事'), false);
  } finally { await f.close(); }
});

test('removed memberships never mount a group editor and v2 members cannot use administrator activation controls', async () => {
  const context = { userId: 'member', group: { userId: 'member', groupId: 'family', displayName: '家族', status: 'removed' } };
  let reads = 0;
  const removed = screenHarness('src/app/sharing/chore-settings/[id].tsx', { params: { id: 'chore', groupId: 'family' }, mocks: {
    '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: context } },
    '@/platform/sharing/workspaces': { openSharedWorkspace: async () => { reads++; throw new Error('must not open'); } },
    './use-group-chore-settings': { useGroupChoreSettings: () => { reads++; throw new Error('must not load'); } },
  } });
  assert.equal(reads, 0); assert.ok(removed.text().includes('このグループは現在編集できません'));
  context.group.status = 'active'; const navigation = [];
  const member = screenHarness('src/features/settings/chore-settings-sources.tsx', { exportName: 'ChoreSettingsSources', props: { first: 'group' }, navigate: (...args) => navigation.push(args), mocks: {
    '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: context } },
    './use-group-chore-settings': { useGroupChoreSettings: () => ({ snapshot: { protocol: 2, model: { viewerUserId: 'member', adminUserId: 'owner',
      plan: { chores: [{ id: 'chore', name: '共有の家事', category: '分類', enabled: true }] } } }, source: { saveEnabled: async () => { throw new Error('must not save'); } } }) },
  } });
  await member.press('分類の見出しを展開');
  assert.equal(member.nodes().filter(node => node.type === 'Switch').length, 1);
  assert.equal(member.nodes().find(node => node.type === 'Switch').props.disabled, true);
  await member.press('共有の家事の個別設定'); assert.equal(navigation.at(-1)[1].params.groupId, 'family');
});

test('fixed audience stays outside the virtual document and a thousand chores keep bounded rail marks', () => {
  const chores = Array.from({ length: 1000 }, (_, i) => ({ id: `c-${i}`, name: `家事${i}`, category: `分類${Math.floor(i / 200)}` }));
  const book = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', props: { chores, selectedId: 'c-850', title: '家事ごとの設定',
    titleAccessory: '個人用', renderChore: chore => chore.name, onBack() {} } });
  assert.equal(book.text().split('個人用').length - 1, 1);
  const list = book.nodes().find(node => node.type === 'FlatList'); assert.equal(allNodes([list]).some(node => node.children?.includes('個人用')), false);
  assert.ok(book.nodes().filter(node => node.props.accessibilityRole === 'button').length <= 90);
  assert.ok(book.button('分類4の先頭へ移動')); assert.equal(list.props.data[0].id, 'c-850');
  list.props.onScrollBeginDrag(); book.render(); assert.equal(book.nodes().find(node => node.type === 'FlatList').props.data.length, 1000);
});

test('v2 Settings keeps both chore audiences and routes waste management to its supported group screen', async () => {
  const f = await legacyFixture(); const navigation = [];
  try {
    const effects = [];
    const screen = screenHarness('src/app/settings.tsx', { effect: callback => effects.push(callback), database: f.personal.database, snapshot: () => f.personalData.snapshot,
      personalData: () => f.personalData, navigate: (...args) => navigation.push(args), mocks: {
        '@/platform/sharing/private-calendar-secrets': { nativePrivatePlannerPreferences: () => ({ read: async () => null }) },
        '@/platform/sharing/workspaces': { sharingSessionUser: async () => ({ uid: f.scope.userId }), hasOtherGoogleWorkspaceConnections: async () => false },
        '@/features/google-sync/background-task': {},
        '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
        '@/platform/google-tasks/google-sign-in-gateway': {},
        '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { active: { protocol: 2 }, userId: f.scope.userId, group: f.record } } },
        './use-group-chore-settings': { useGroupChoreSettings: () => ({ ...f.source.getSnapshot(), source: f.source }) },
      } });
    effects.splice(0).forEach(callback => callback()); for (let n = 0; n < 8; n++) await screen.flush();
    await screen.press('共有グループを管理'); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/sharing/group/[groupId]', params: { groupId: f.record.groupId } }]);
    assert.ok(screen.text().indexOf('個人用') < screen.text().indexOf('グループ用 · 家族'));
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '家事ごとの設定を開く'), false);
    await screen.press('ゴミ収集日を管理'); assert.deepEqual(navigation.at(-1), ['push', '/group-v2/waste']);
  } finally { await f.close(); }
});

for (const platform of ['ios', 'android']) test(`${platform} ordinary settings waits for the restored account before reading protected rhythm and rejects a changed identity`, async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); const snapshot = await repository.loadPlannerSnapshot(h.database);
    for (const uid of ['owner', 'another-account']) {
      const effects = []; let finish; let reads = 0;
      const authentication = new Promise(resolve => { finish = resolve; });
      const screen = screenHarness('src/app/settings.tsx', { platform, database: h.database, snapshot: () => snapshot,
        effect: callback => effects.push(callback), effectDependencies: true, mocks: {
          '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { userId: 'owner', active: null } } },
          '@/platform/sharing/workspaces': { sharingSessionUser: () => authentication, hasOtherGoogleWorkspaceConnections: async () => false },
          '@/features/google-sync/background-task': {},
          '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
          '@/platform/google-tasks/google-sign-in-gateway': {},
          '@/platform/sharing/private-calendar-secrets': { nativePrivatePlannerPreferences: () => {
            reads++; return { read: async () => null };
          } },
        } });
      const cleanup = effects.splice(0).map(effect => effect()); await screen.flush();
      assert.equal(reads, 0); assert.equal(screen.text().includes('本人の生活リズムを読み込めませんでした'), false);
      assert.ok(screen.button('前の画面に戻る'), 'loading must retain a way back');
      finish({ uid }); for (let n = 0; n < 8; n++) await screen.flush();
      assert.equal(reads, uid === 'owner' ? 1 : 0);
      assert.equal(screen.text().includes('家事ごとの設定'), uid === 'owner');
      assert.equal(screen.text().includes('本人の生活リズムを読み込めませんでした'), uid !== 'owner');
      assert.ok(screen.button('前の画面に戻る'), 'failed authentication must retain a way back');
      cleanup.forEach(dispose => dispose?.()); screen.unmount();
    }
  } finally { h.connection.close(); }
});

test('v2 detached settings use management-only reads and existing single-chore authority without private services or category partial writes', async () => {
  const f = await workspaceHarness({ deferWorkspaceTimers: true });
  try {
    const source = createGroupChoreSettingsSource(f.record, f.api.openSharedWorkspace); await source.refresh(); const value = source.getSnapshot().snapshot;
    assert.equal(value.protocol, 2); assert.equal(value.model.personal, undefined); assert.equal(value.model.privateOverlay, undefined);
    const initial = value.model.plan.chores[0];
    await value.workspace.session.controller.actions.configureChore(initial.id, { policy: chorePolicyFromPreset('common'), anchorDate: today, effectiveFrom: today,
      intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, active: true }); await source.refresh();
    const chore = source.getSnapshot().snapshot.model.plan.chores.find(row => row.id === initial.id);
    const before = await listSharingOutbox(value.workspace.database, f.record.groupId);
    await assert.rejects(source.saveEnabled([chore.id, 'another'], false), /一件ずつ/u);
    assert.deepEqual(await listSharingOutbox(value.workspace.database, f.record.groupId), before);
    await source.saveEnabled([chore.id], !chore.enabled); const after = source.getSnapshot().snapshot;
    assert.equal(after.model.plan.chores.find(row => row.id === chore.id).enabled, !chore.enabled);
    assert.equal(after.model.configurations.find(row => row.choreId === chore.id).configuration.active, !chore.enabled);
    const outbox = await listSharingOutbox(value.workspace.database, f.record.groupId);
    const tasksAfterEdit = [...f.taskCalls], remindersAfterEdit = [...f.reminderCalls]; await source.refresh();
    assert.deepEqual(await listSharingOutbox(value.workspace.database, f.record.groupId), outbox);
    assert.deepEqual(f.taskCalls, tasksAfterEdit); assert.deepEqual(f.reminderCalls, remindersAfterEdit, 'reading settings does not start another lifecycle worker');
    f.auth.uid = 'another'; await assert.rejects(source.saveEnabled([chore.id], chore.enabled));
  } finally { await await f.close(); }
});

test('chore rows show their execution period without an early badge or source-specific timing label', () => {
  for (const home of [true, false]) for (const completed of [false, true]) {
    const screen = screenHarness('src/components/task-checkbox-row.tsx', { exportName: 'TaskCheckboxRow', props: {
      chore: { name: '洗濯', category: '洗濯', estimatedMinutes: 30 }, executionWindow: { start: '2026-10-28', end: '2026-11-01' }, home, completed, onOpen() {}, onToggle() {} } });
    assert.equal(screen.text().includes('推奨日前'), false); assert.match(screen.text(), /10月28日.*11月1日/u);
    assert.equal(Boolean(screen.nodes().find(node => node.props.accessibilityRole === 'button').props.accessibilityHint?.includes('推奨日前')), false);
  }
});
