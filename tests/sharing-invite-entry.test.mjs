import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { encodeSharedInvitation } from '../src/features/sharing/invitations.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function entry(platform, link, overrides = {}) {
  const state = { uid: 'member', ready: true, group: null, url: link, ...overrides };
  const calls = { login: 0, request: [], refresh: 0, routes: [] };
  const screen = screenHarness('src/app/sharing/join.tsx', { platform,
    effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
    navigate: (action, route) => calls.routes.push([action, route]), mocks: {
      'expo-linking': { useLinkingURL: () => state.url },
      '@/hooks/use-workspace': { useWorkspace: () => ({ ready: state.ready, userId: state.uid, group: state.group,
        refreshSharing: async () => { calls.refresh++; } }) },
      '@/platform/sharing/auth': { signInSharingWithGoogle: async () => { calls.login++; if (state.login) return state.login(); state.uid = 'member'; return { uid: state.uid }; } },
      '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingSessionUser: async () => state.uid ? { uid: state.uid } : null,
        sharingFailureMessage: () => '申請できませんでした。', requestSharingWorkspace: async url => {
          calls.request.push(url); if (state.request) return state.request(url); return { groupId: 'joined-group' };
        } },
    } });
  return { screen, state, calls };
}
async function settle(screen) { for (let i = 0; i < 3; i++) await screen.flush(); }

for (const platform of ['ios', 'android']) {
  test(`${platform} invitation entry submits once after readiness without a second confirmation`, async () => {
    const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
    const link = encodeSharedInvitation(h.link), gate = deferred();
    const { screen, state, calls } = entry(platform, link, { ready: false, request: () => gate.promise });
    try {
      await settle(screen); assert.deepEqual(calls.request, []);
      state.ready = true; screen.render(); await settle(screen);
      assert.deepEqual(calls.request, [link]); assert.equal(calls.login, 0);
      for (let i = 0; i < 5; i++) screen.render();
      assert.equal(calls.request.length, 1);
      gate.resolve({ groupId: 'joined-group' }); await settle(screen);
      assert.deepEqual(calls.routes, [['replace', { pathname: '/sharing/group/[groupId]', params: { groupId: 'joined-group' } }]]);
      assert.equal(calls.refresh, 1);
      assert.ok(!JSON.stringify(calls.routes).includes('#v'), 'invitation secrets never enter route parameters');
    } finally { gate.resolve({ groupId: 'joined-group' }); screen.unmount(); await h.close(); }
  });

  test(`${platform} invitation entry retains the original fragment across login callbacks and rechecks expiry`, async t => {
    const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
    try {
      for (const expired of [false, true]) {
        const link = encodeSharedInvitation(h.link), gate = deferred();
        const originalNow = Date.now;
        const { screen, state, calls } = entry(platform, link, { uid: null, login: () => gate.promise });
        try {
          await settle(screen); assert.equal(calls.login, 1); assert.equal(calls.request.length, 0);
          state.url = 'houseworkplanner://oauth?code=synthetic'; screen.render(); await settle(screen);
          if (expired) t.mock.method(Date, 'now', () => h.link.invitation.body.expiresAt + 1);
          state.uid = 'member'; gate.resolve({ uid: 'member' }); await settle(screen);
          assert.deepEqual(calls.request, expired ? [] : [link]);
          assert.equal(calls.routes.length, expired ? 0 : 1);
          if (expired) assert.ok(screen.nodes().some(node => node.props.accessibilityRole === 'alert'));
        } finally { Date.now = originalNow; gate.resolve({ uid: 'member' }); screen.unmount(); }
      }
    } finally { await h.close(); }
  });

  test(`${platform} invitation entry rejects invalid links and other memberships and reuses the same pending group`, async () => {
    const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
    const link = encodeSharedInvitation(h.link), groupId = h.link.invitation.body.groupId;
    try {
      for (const fixture of [
        { url: 'houseworkplanner://sharing/join#v2=invalid' },
        { group: { userId: 'member', groupId: 'another-group', status: 'active' } },
        { group: { userId: 'member', groupId: 'another-group', status: 'joining' } },
        { group: { userId: 'member', groupId, status: 'joining' }, same: true },
        { group: { userId: 'member', groupId, status: 'active' }, same: true },
      ]) {
        const { screen, calls } = entry(platform, link, fixture);
        try {
          await settle(screen); assert.equal(calls.login, 0); assert.deepEqual(calls.request, []);
          assert.equal(calls.routes.length, fixture.same ? 1 : 0);
          if (fixture.same) assert.equal(calls.routes[0][1].params.groupId, groupId);
        } finally { screen.unmount(); }
      }
    } finally { await h.close(); }
  });

  test(`${platform} invitation failures wait for explicit retry and superseded invitations cannot navigate`, async () => {
    const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
    const link = encodeSharedInvitation(h.link);
    const { screen, state, calls } = entry(platform, link, { request: async () => { throw new Error('synthetic failure'); } });
    try {
      await settle(screen); assert.equal(calls.request.length, 1);
      await settle(screen); assert.equal(calls.request.length, 1, 'failures do not repeatedly submit in an effect');
      state.request = async () => ({ groupId: 'joined-group' });
      await screen.press('再試行'); await settle(screen);
      assert.equal(calls.request.length, 2); assert.equal(calls.routes.length, 1);
    } finally { screen.unmount(); }
    const gate = deferred(); const late = entry(platform, link, { request: () => gate.promise });
    try {
      await settle(late.screen); late.state.url = 'houseworkplanner://sharing/join#v2=invalid';
      late.screen.render(); await settle(late.screen);
      gate.resolve({ groupId: 'old-group' }); await settle(late.screen);
      assert.deepEqual(late.calls.routes, []); assert.equal(late.calls.refresh, 0);
    } finally { gate.resolve({ groupId: 'old-group' }); late.screen.unmount(); await h.close(); }
  });
}
