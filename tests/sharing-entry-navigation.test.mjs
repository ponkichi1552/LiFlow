import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

function entry(platform, context, workspaces = {}, routes = []) {
  return screenHarness('src/app/sharing/index.tsx', { platform, layoutEffect: callback => callback(),
    navigate: (...args) => routes.push(args), mocks: {
      '@/hooks/use-workspace': { useWorkspace: () => context }, 'expo-image': { Image: 'Image' },
      '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
      '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false },
      '@/platform/sharing/workspaces': { enableSharingSession: async () => {},
        sharingFailureMessage: () => '接続を確認して再試行してください。', ...workspaces },
    } });
}
const input = (ui, name) => ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === name);

for (const [platform, draftsName, joiningName] of [
  ['ios', 'ios sharing entry opens the join form directly and preserves account-scoped drafts across method changes',
    "ios joining retries the same draft once and ignores a previous account's late acceptance"],
  ['android', 'android sharing entry opens the join form directly and preserves account-scoped drafts across method changes',
    "android joining retries the same draft once and ignores a previous account's late acceptance"],
]) {
  test(draftsName, async () => {
    const context = { userId: 'owner', group: null, active: null, ready: true, refreshSharing: async () => {} };
    const ui = entry(platform, context);
    assert.ok(input(ui, '招待リンク')); assert.equal(input(ui, 'グループ名'), undefined);
    assert.equal(ui.button('参加する').props.accessibilityState.selected, true);
    await ui.change('招待リンク', 'houseworkplanner://sharing/join#test-draft');
    await ui.press('作成する');
    assert.equal(input(ui, '招待リンク'), undefined);
    await ui.change('グループ名', '作成途中');
    const family = ui.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '家族');
    family.props.onPress(); await ui.flush();
    await ui.press('参加する'); assert.equal(input(ui, '招待リンク').props.value, 'houseworkplanner://sharing/join#test-draft');
    await ui.press('作成する'); assert.equal(input(ui, 'グループ名').props.value, '作成途中');
    assert.equal(ui.button('グループを作成').props.disabled, false);
    context.userId = 'other'; await ui.flush();
    assert.equal(input(ui, 'グループ名').props.value, '');
    await ui.press('参加する'); assert.equal(input(ui, '招待リンク').props.value, '');
    assert.equal(ui.button('参加を申請').props.disabled, true);
    context.userId = null; await ui.flush();
    assert.equal(input(ui, '招待リンク'), undefined); assert.equal(input(ui, 'グループ名'), undefined);
    ui.button('Googleで続ける');
  });

  test(joiningName, async () => {
    const context = { userId: 'owner', group: null, active: null, ready: true, refreshSharing: async () => {} };
    const routes = []; const calls = []; let settle;
    const ui = entry(platform, context, { requestSharingWorkspace: async link => {
      calls.push(link); return new Promise((resolve, reject) => { settle = { resolve, reject }; });
    } }, routes);
    await ui.change('招待リンク', 'houseworkplanner://sharing/join#retry');
    const submit = ui.button('参加を申請').props.onPress;
    submit(); submit(); await ui.flush(); assert.equal(calls.length, 1);
    assert.equal(input(ui, '招待リンク').props.editable, false);
    assert.equal(ui.button('作成する').props.disabled, true);
    settle.reject(new Error('offline')); await ui.flush();
    assert.equal(input(ui, '招待リンク').props.value, calls[0]);
    assert.equal(ui.button('参加を申請').props.disabled, false); assert.match(ui.text(), /再試行/u);
    ui.button('参加を申請').props.onPress(); await ui.flush(); assert.equal(calls.length, 2);
    context.userId = 'other'; await ui.flush();
    settle.resolve({ groupId: 'old-account-group' }); await ui.flush();
    assert.deepEqual(routes, []); assert.equal(input(ui, '招待リンク').props.value, '');
  });
}
