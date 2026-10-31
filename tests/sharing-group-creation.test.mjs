import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import * as rollout from '../src/features/sharing/rollout.ts';
const { sharingCreationProtocol } = rollout;

function form(props, options = {}) {
  return screenHarness('src/features/sharing/group-creation-form.tsx', {
    exportName: 'GroupCreationForm', props: { protocol: 2, busy: false, ...props }, ...options,
  });
}
async function choose(screen, label) {
  const node = screen.nodes().find(item => item.props.accessibilityRole === 'radio' && item.props.accessibilityLabel === label);
  assert.ok(node, `missing choice: ${label}`); assert.equal(node.props.disabled, false);
  node.props.onPress(); await screen.flush();
}
function input(screen) { return screen.nodes().find(item => item.type === 'TextInput' && item.props.accessibilityLabel === 'グループ名'); }

test('new shared groups always use v2 even when a retired rollout flag is false', t => {
  const previous = process.env.EXPO_PUBLIC_SHARING_V2_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.EXPO_PUBLIC_SHARING_V2_ENABLED; else process.env.EXPO_PUBLIC_SHARING_V2_ENABLED = previous; });
  delete process.env.EXPO_PUBLIC_SHARING_V2_ENABLED; assert.equal(sharingCreationProtocol(), 2);
  for (const value of ['', 'true', 'TRUE', ' true', 'true ', '1', 'yes']) assert.equal(sharingCreationProtocol(value), 2);
  assert.equal(sharingCreationProtocol('false'), 2);
});

test('owner recovery is enabled for the standard deployment and can be explicitly disabled without reading group data', t => {
  const previous = process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY;
  t.after(() => { if (previous === undefined) delete process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY; else process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY = previous; });
  delete process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY; assert.equal(rollout.sharingOwnerRecoveryEnabled(), true);
  assert.equal(rollout.sharingOwnerRecoveryEnabled('true'), true); assert.equal(rollout.sharingOwnerRecoveryEnabled('false'), false);
});

for (const [kind, name] of [
  ['family', 'v2 group creation requires an explicit family choice and does not imply a delegated chore grant'],
  ['roommates', 'v2 group creation requires an explicit roommates choice and does not imply a delegated chore grant'],
]) test(name, async () => {
  const calls = []; const ui = form({ onCreate: async (...args) => { calls.push(args); return true; } });
  assert.equal(ui.nodes().filter(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityState.checked).length, 0);
  await ui.change('グループ名', '  検査グループ  ');
  assert.equal(ui.button('グループを作成').props.disabled, true);
  await ui.button('グループを作成').props.onPress(); assert.deepEqual(calls, []);
  await choose(ui, kind === 'family' ? '家族' : '同居人');
  assert.match(ui.text(), kind === 'family' ? /初期ON.*管理者が家事ごとに付与/u : /初期OFF/u);
  await ui.press('グループを作成'); assert.deepEqual(calls, [['検査グループ', kind]]);
  assert.equal(input(ui).props.value, '');
  assert.equal(ui.nodes().filter(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityState.checked).length, 0);
});

test('group creation keeps the same inputs across false results and thrown failures and submits once per pending commit', async () => {
  const calls = []; let resolve; let mode = 'pending';
  const ui = form({ onCreate: async (...args) => { calls.push(args); if (mode === 'throw') throw new Error('offline'); return new Promise(done => { resolve = done; }); } });
  await ui.change('グループ名', '家族'); await choose(ui, '家族');
  const submit = ui.button('グループを作成').props.onPress;
  const pending = submit(); await submit(); assert.equal(calls.length, 1); await ui.flush();
  assert.equal(input(ui).props.editable, false); assert.equal(ui.button('グループを作成').props.disabled, true);
  resolve(false); await pending; await ui.flush();
  assert.equal(input(ui).props.value, '家族'); assert.equal(ui.button('グループを作成').props.disabled, false);
  assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '家族').props.accessibilityState.checked, true);
  mode = 'throw'; await ui.press('グループを作成');
  assert.match(ui.text(), /入力内容は保持/u); assert.equal(input(ui).props.value, '家族'); assert.equal(calls.length, 2);
});

test('unmounting a pending creation form prevents its late success from clearing the preserved form', async () => {
  let resolve; let dispose;
  const ui = form({ onCreate: () => new Promise(done => { resolve = done; }) }, { effect: callback => { dispose ??= callback(); } });
  await ui.change('グループ名', '作成中'); await choose(ui, '同居人');
  const pending = ui.button('グループを作成').props.onPress(); dispose(); resolve(true); await pending; await ui.flush();
  assert.equal(input(ui).props.value, '作成中');
});

for (const [platform, name] of [
  ['ios', "ios normal sharing screen forwards explicit v2 kind and ignores a previous account's late creation"],
  ['android', "android normal sharing screen forwards explicit v2 kind and ignores a previous account's late creation"],
]) test(name, async () => {
  const calls = []; let resolve;
  const context = { active: null, userId: 'owner', group: null, ready: true, refreshSharing: async () => { calls.push(['refresh']); } };
  const ui = screenHarness('src/app/sharing/index.tsx', { platform, layoutEffect: callback => callback(), mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => context }, 'expo-image': { Image: 'Image' },
    '@/features/sharing/rollout': { sharingCreationProtocol: () => 2 },
    '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
    '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false },
    '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingFailureMessage: () => '再試行してください。',
      createSharingWorkspace: () => assert.fail('v2 choice must not create a legacy group'),
      createV2SharingWorkspace: async (...args) => { calls.push(['create', ...args]); return new Promise(done => { resolve = done; }); } },
  } });
  await ui.press('グループを作るを開く'); await ui.change('グループ名', '旧アカウントのグループ'); await choose(ui, '同居人');
  const pending = ui.button('グループを作成').props.onPress();
  assert.deepEqual(calls, [['create', '旧アカウントのグループ', 'roommates']]);
  context.userId = 'next-account'; await ui.flush();
  assert.equal(input(ui).props.value, '', 'switching account remounts the account-scoped form');
  resolve({ userId: 'owner', groupId: 'old-account-created' }); await pending; await ui.flush();
  assert.equal(ui.nodes().filter(node => node.type === 'ActivityIndicator').length, 0, 'late success must not select another account group');
  assert.equal(context.active, null);
});

test('retired legacy creation input cannot bypass the explicit v2 group kind', async () => {
  const calls = []; const ui = form({ protocol: 1, onCreate: async (...args) => { calls.push(args); return true; } });
  await ui.change('グループ名', '旧設定からの作成');
  assert.equal(ui.button('グループを作成').props.disabled, true);
  await choose(ui, '家族'); await ui.press('グループを作成');
  assert.deepEqual(calls, [['旧設定からの作成', 'family']]);
});

test('a saved group creation remains successful when refreshing the group list fails afterward', async () => {
  let create; let count = 0;
  const context = { active: null, userId: 'owner', group: null, ready: true, refreshSharing: async () => { throw new Error('list unavailable'); } };
  const ui = screenHarness('src/app/sharing/index.tsx', { mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => context }, 'expo-image': { Image: 'Image' },
    '@/features/sharing/rollout': { sharingCreationProtocol: () => 2 },
    '@/features/sharing/group-creation-form': { GroupCreationForm: props => { create = props.onCreate; return null; } },
    '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
    '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false },
    '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingFailureMessage: () => '一覧を再取得してください。',
      createV2SharingWorkspace: async () => { count++; return { userId: 'owner', groupId: 'already-saved-group' }; } },
  } });
  await ui.press('グループを作るを開く');
  assert.equal(await create('保存済み', 'family'), true, 'a refresh failure must not invite a duplicate creation retry');
  await ui.flush(); assert.equal(count, 1); assert.match(ui.text(), /一覧を再取得/u);
});
