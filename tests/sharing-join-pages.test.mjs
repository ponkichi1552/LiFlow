import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { createSharedInvitation, createSharedJoinRequest } from '../src/features/sharing/invitations.ts';

for (const platform of ['ios', 'android']) test(`${platform} group requests retain continuation after failure and never hide valid requests behind an invalid page`, async t => {
  const identity = await createDeviceIdentity(crypto); const roster = createSharedRoster('join-pages', 'owner', identity);
  const link = await createSharedInvitation(crypto, roster, identity, 'paged-invite', Date.now());
  const request = createSharedJoinRequest(link, 'good-person', await createDeviceIdentity(crypto), Date.now());
  const invalid = Array.from({ length: 100 }, (_, n) => `bad-${String(n).padStart(3, '0')}`);
  let failPage = true; let failDelete = true; let approved = 0; const deleted = []; const failures = [];
  const context = { userId: 'owner', refreshSharing: async () => {} };
  const workspace = { protocol: 2, userId: 'owner', groupId: 'join-pages', identity, session: { recovery: {} },
    roster: () => roster, record: async () => ({ status: 'active', displayName: '家族' }), checkpoint: async () => ({ pendingCount: 0 }),
    readOverview: async () => ({ members: [{ id: 'owner', displayName: '自分' }], timeZone: 'Asia/Tokyo' }),
    manager: { approve: async () => { approved++; } }, cloud: {
      listInvitations: async () => [{ invitation: link.invitation, status: 'open' }],
      listJoinRequests: async (_invitation, cursor) => {
        if (!cursor) return { requests: [], invalidUserIds: invalid, nextCursor: 'bad-099' };
        assert.equal(cursor, 'bad-099'); if (failPage) throw new Error('synthetic next page unavailable');
        return { requests: [request], invalidUserIds: [], nextCursor: null };
      },
      withdrawOrRejectJoinRequest: async (inviteId, userId) => {
        assert.equal(inviteId, link.invitation.body.inviteId); assert.ok(invalid.includes(userId));
        if (userId === 'bad-004' && failDelete) { failDelete = false; throw new Error('synthetic cleanup unavailable'); }
        assert.ok(!deleted.includes(userId)); deleted.push(userId);
      },
    } };
  const screen = screenHarness('src/features/sharing/sharing-manager-screen.tsx', { platform, exportName: 'GroupDetail',
    props: { workspace, section: 'members', busy: false, run: async work => { try { await work(); return true; } catch (error) { failures.push(error); return false; } } },
    effectDependencies: true, focusDependencies: true, effect: callback => callback(), mocks: {
      '@/hooks/use-workspace': { useWorkspace: () => context }, 'expo-image': { Image: 'Image' },
      '@/features/sharing/v2-ui/workspace-data': { useOptionalWorkspaceDisplay: () => null },
      '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false },
      '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
      '@/platform/sharing/workspaces': { subscribeSharingChanges: () => () => {}, sharingFailureMessage: () => '通信を確認してください。' },
      '@/features/settings/chore-settings-sources': { ChoreSettingsSources: () => null },
      './group-management-links': { GroupManagementLinks: () => null },
      '@/features/sharing/v2/recovery-panel': { V2RecoveryPanel: () => null },
      '@/features/sharing/v2/legacy-migration-panel': { LegacyMigrationPanel: () => null },
    } });
  t.after(() => screen.unmount()); await screen.flush();
  await screen.flush();
  assert.equal(screen.text().includes('申請はありません。'), false); assert.match(screen.text(), /確認できない参加申請：100件/);
  await screen.press('参加申請の続きを取得'); await screen.flush();
  assert.equal(failures.length, 1); assert.ok(screen.button('参加申請の続きを取得')); assert.equal(approved, 0);
  failPage = false; await screen.press('参加申請の続きを取得'); await screen.flush();
  assert.ok(screen.button('この端末の参加を承認')); assert.equal(screen.text().includes('申請はありません。'), false);
  await screen.press('確認できない申請を削除'); await screen.flush();
  assert.equal(failures.length, 2); assert.equal(deleted.length, 7);
  await screen.press('確認できない申請を削除'); await screen.flush();
  assert.equal(deleted.length, 100); assert.equal(screen.text().includes('確認できない参加申請'), false);
  assert.ok(screen.button('この端末の参加を承認')); assert.equal(approved, 0, 'invalid requests never reach approval');
});
