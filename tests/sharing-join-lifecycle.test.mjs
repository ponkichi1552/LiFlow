import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { encodeSharedInvitation } from '../src/features/sharing/invitations.ts';
for (const platform of ['ios', 'android']) for (const after of ['current', 'account-change', 'unmount']) test(`${platform} invite join ignores a late ${after} result unless the original screen and account still own it`, async () => {
  const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true }); let screen; let release;
  const routes = []; let owner = 'member'; let starts = 0;
  try {
    screen = screenHarness('src/app/sharing/join.tsx', { platform, navigate: (action, route) => routes.push([action, route]),
      effectDependencies: true, effect: callback => callback(), mocks: {
        'expo-linking': { useLinkingURL: () => encodeSharedInvitation(h.link) },
        '@/hooks/use-workspace': { useWorkspace: () => ({ userId: owner, group: null, refreshSharing: async () => {} }) },
        '@/platform/sharing/auth': {},
        '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingSessionUser: async () => ({ uid: owner }), sharingFailureMessage: () => '取得に失敗',
          requestSharingWorkspace: async () => { starts++; await new Promise(resolve => { release = resolve; }); return { userId: 'member', groupId: 'joined-group' }; } },
      } });
    screen.button('この招待から参加を申請').props.onPress(); await screen.flush(); assert.equal(starts, 1);
    if (after === 'account-change') { owner = 'other'; screen.render(); }
    if (after === 'unmount') screen.unmount();
    release(); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(routes.length, after === 'current' ? 1 : 0);
    if (after === 'current') assert.equal(routes[0][1].params.groupId, 'joined-group');
  } finally { release?.(); screen?.unmount(); await h.close(); }
});
