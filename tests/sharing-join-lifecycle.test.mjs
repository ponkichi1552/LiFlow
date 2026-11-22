import './helpers/typescript-loader.mjs';
import test from 'node:test';
import { redirectSystemPath } from '../src/app/+native-intent.ts';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { encodeSharedInvitation } from '../src/features/sharing/invitations.ts';

test('an invitation blocked by the signed-in user’s current group opens that group directly', async t => {
  const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
  t.after(() => h.close());
  const routes = [];
  const screen = screenHarness('src/app/sharing/join.tsx', { effectDependencies: true, effect: callback => callback(),
    navigate: (action, route) => routes.push([action, route]), mocks: {
      'expo-linking': { useLinkingURL: () => encodeSharedInvitation(h.link) },
      '@/hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: 'member',
        group: { userId: 'member', groupId: 'current-group', status: 'active' } }) },
      '@/platform/sharing/auth': {},
      '@/platform/sharing/workspaces': { requestSharingWorkspace: async () => assert.fail('A blocked invitation must not be sent') },
    } });
  t.after(() => screen.unmount());
  await screen.press('現在のグループを開く');
  assert.deepEqual(routes, [['replace', { pathname: '/sharing/group/[groupId]', params: { groupId: 'current-group' } }]]);
});

for (const [platform, method] of [['ios', 'apple'], ['ios', 'google'], ['android', 'google']]) test(`${platform} signed-out invitation waits for explicit ${method} sign-in before submitting`, async t => {
  const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
  const link = encodeSharedInvitation(h.link);
  const calls = [];
  let owner = null;
  let canceled = true;
  const signIn = async provider => {
    calls.push(provider);
    if (canceled) { canceled = false; throw new Error('ログインをキャンセルしました。'); }
    owner = 'member';
    return { uid: owner };
  };
  const screen = screenHarness('src/app/sharing/join.tsx', { platform, effectDependencies: true, effect: callback => callback(),
    navigate: (_action, route) => { if (route.params?.groupId === 'joined-group') calls.push('navigated'); },
    mocks: {
      'expo-linking': { useLinkingURL: () => link },
      '@/hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: owner, group: null, refreshSharing: async () => {} }) },
      '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => platform === 'ios',
        signInSharingWithGoogle: () => signIn('google'), signInSharingWithApple: () => signIn('apple') },
      '@/platform/sharing/workspaces': { enableSharingSession: async () => { calls.push('enabled'); },
        sharingSessionUser: async () => owner ? { uid: owner } : null,
        requestSharingWorkspace: async (target, expectedOwner) => { assert.equal(target, link); assert.equal(expectedOwner, 'member'); assert.equal(owner, 'member'); calls.push('submitted'); return { groupId: 'joined-group' }; } },
    } });
  t.after(async () => { screen.unmount(); await h.close(); });
  await screen.flush();
  assert.deepEqual(calls, []);
  if (platform === 'android') assert.throws(() => screen.button('Appleで続ける'), /missing button/u);
  const label = method === 'apple' ? 'Appleで続ける' : 'Googleで続ける';
  await screen.press(label);
  assert.deepEqual(calls, [method]);
  assert.match(screen.text(), /ログインをキャンセル/u);
  await screen.press(label);
  await screen.flush();
  assert.deepEqual(calls, [method, method, 'enabled', 'submitted', 'navigated']);
});

for (const platform of ['ios', 'android']) for (const after of ['current', 'account-change', 'unmount']) test(`${platform} invite join ignores a late ${after} result unless the original screen and account still own it`, async () => {
  const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true }); let screen; let release;
  const routes = []; let owner = 'member'; let starts = 0;
  try {
    screen = screenHarness('src/app/sharing/join.tsx', { platform, navigate: (action, route) => routes.push([action, route]),
      effectDependencies: true, effect: callback => callback(), mocks: {
        'expo-linking': { useLinkingURL: () => encodeSharedInvitation(h.link) },
        '@/hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: owner, group: null, refreshSharing: async () => {} }) },
        '@/platform/sharing/auth': {},
        '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingSessionUser: async () => ({ uid: owner }), sharingFailureMessage: () => '取得に失敗',
          requestSharingWorkspace: async () => { starts++; await new Promise(resolve => { release = resolve; }); return { userId: 'member', groupId: 'joined-group' }; } },
      } });
    await screen.flush(); assert.equal(starts, 1);
    if (after === 'account-change') { owner = 'other'; screen.render(); }
    if (after === 'unmount') screen.unmount();
    release(); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(routes.length, after === 'current' ? 1 : 0);
    if (after === 'current') assert.equal(routes[0][1].params.groupId, 'joined-group');
  } finally { release?.(); screen?.unmount(); await h.close(); }
});
test('native Google sign-in callbacks leave the current screen and LiFlow links intact', () => {
  for (const initial of [true, false]) {
    for (const path of ['oauth2callback', 'emmcallback', 'oauthredirect', 'oauth2redirect']) {
      assert.equal(redirectSystemPath({ path: `com.googleusercontent.apps.synthetic:/${path}`, initial }), null);
    }
    for (const path of ['liflow-ui-check:///settings?section=general', 'liflow:///sharing/join?invite=sample', '/settings', 'liflow-ui-check://expo-development-client/?url=sample']) {
      assert.equal(redirectSystemPath({ path, initial }), path);
    }
  }
});
