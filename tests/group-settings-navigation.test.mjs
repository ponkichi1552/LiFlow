import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

async function openGroup(platform, { owner = true, recordFailures = 0, requestFailures = 0, lastErrorCode = null, heldChanges = 0 } = {}) {
  let syncs = 0; let refreshes = 0; let recordReads = 0; let invitationReads = 0; const commands = []; const routes = []; const alerts = [];
  const roster = { body: { ownerUserId: 'owner', ownerDeviceId: 'owner-device', schedulerVersion: 'liflow-shared-2-draft-41', members: [
    { userId: 'owner', devices: [{ identity: { deviceId: 'owner-device' } }] },
    { userId: 'member', devices: [{ identity: { deviceId: 'member-device' } }] },
  ] } };
  const workspace = { protocol: 2, groupId: 'synthetic-group', userId: owner ? 'owner' : 'member',
    identity: { deviceId: owner ? 'owner-device' : 'member-device' }, roster: () => roster,
    record: async () => { if (recordReads++ < recordFailures) throw new Error('端末の設定を読み込めません。');
      return { status: 'active', displayName: '検査用グループ', lastErrorCode, lastSuccessfulSyncAt: null }; },
    checkpoint: async () => ({ pendingCount: 2 }), readOverview: async () => ({ timeZone: 'Asia/Tokyo', members: [
      { id: 'owner', displayName: '所有者' }, { id: 'member', displayName: '参加者' },
    ], recoverySummary: { heldChanges } }),
    cloud: { listInvitations: async () => { if (invitationReads++ < requestFailures) throw new Error('参加申請を取得できません。'); return []; }, listJoinRequests: async () => ({ requests: [] }) },
    session: { recovery: { enabled: true } }, sync: async options => { assert.equal(options.force, true); syncs++; },
    manager: { transferOwnership: async target => commands.push(['transfer', target]),
      removeMembers: async ids => commands.push(['remove', ids]), leave: async () => commands.push(['leave']),
      createInvitation: async () => { throw new Error('No invitation is created by navigation tests.'); } },
  };
  const screen = screenHarness('src/features/sharing/sharing-manager-screen.tsx', { platform, exportName: 'GroupDetail',
    props: { workspace, run: async work => { await work(); refreshes++; return true; }, busy: false },
    effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
    navigate: (action, target) => routes.push([action, target]), alert: (...args) => alerts.push(args),
    mocks: {
      'expo-image': { Image: 'Image' },
      '@/hooks/use-workspace': { useWorkspace: () => ({ userId: workspace.userId, refreshSharing: async () => { refreshes++; } }) },
      '@/platform/sharing/workspaces': { subscribeSharingChanges: () => () => {}, sharingFailureMessage: () => '共有の同期に失敗しました。' },
      '@/platform/sharing/firebase-services': { isSharingConfigured: () => false },
      '@/platform/sharing/auth': {},
      '@/features/settings/chore-settings-sources': { ChoreSettingsSources: props => ({ type: 'Text', props: { children: `settings-scope:${props.first}` } }) },
      '@/features/sharing/group-creation-form': { GroupCreationForm: 'GroupCreationForm' },
      '@/features/sharing/v2/legacy-migration-panel': { LegacyMigrationPanel: 'LegacyMigrationPanel' },
      '@/features/sharing/v2/recovery-panel': { V2RecoveryPanel: 'V2RecoveryPanel' },
    },
  });
  for (let n = 0; n < 10 && !screen.text().includes(recordFailures ? 'もう一度読み込む' : 'グループ設定'); n++) await screen.flush();
  return { screen, workspace, routes, alerts, commands, syncs: () => syncs, refreshes: () => refreshes, invitationReads: () => invitationReads };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} group settings open shared controls directly without synchronizing or exposing private integrations`, async () => {
    const ui = await openGroup(platform); const { screen } = ui;
    try {
      assert.match(screen.text(), /グループ設定検査用グループ/u);
      const nativeText = node => typeof node === 'string' ? node : (node.children ?? []).map(nativeText).join('');
      const buttons = screen.nodes().filter(node => node.props.accessibilityRole === 'button').map(node => node.props.accessibilityLabel ?? nativeText(node));
      const everydayFirst = ['家事ごとの設定を開く', '日時変更の申請', '担当変更の申請', 'メンバー・招待（2人）を開く', 'グループ名・ルール'];
      const positions = everydayFirst.map(title => buttons.indexOf(title));
      assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])), 'daily controls precede infrequent group identity setup');
      assert.ok(!/Google|通知|Widget|実施履歴|最終同期|参加端末/u.test(screen.text()));
      await screen.press('グループ名・ルール');
      assert.deepEqual(ui.routes, [['push', '/group-v2/group-rules']]);
      assert.equal(ui.syncs(), 0); assert.equal(ui.refreshes(), 0, 'opening a destination does not start a data refresh');
      await screen.press('家事ごとの設定を開く');
      assert.match(screen.text(), /settings-scope:group/u); assert.ok(!screen.text().includes('settings-scope:personal'));
      await screen.press('ゴミ収集日'); await screen.press('日時変更の申請'); await screen.press('担当変更の申請');
      assert.deepEqual(ui.routes.slice(1), [['push', '/group-v2/waste'], ['push', '/group-v2/requests'], ['push', '/group-v2/assignment-requests']]);
      await screen.press('同期（未送信2件）を開く'); assert.match(screen.text(), /相手の端末への反映は、その端末が同期したとき/u);
      await screen.press('今すぐ同期'); assert.equal(ui.syncs(), 1); assert.equal(ui.refreshes(), 1);
      assert.equal(ui.invitationReads(), 0, 'closed member settings do not fetch unrelated invitations during a manual sync');
    } finally { screen.unmount(); }
  });

  test(`${platform} member and invitation controls preserve owner-device authority and removal confirmation`, async () => {
    for (const owner of [true, false]) {
      const ui = await openGroup(platform, { owner }); const { screen } = ui;
      try {
        await screen.press('メンバー・招待（2人）を開く');
        assert.equal(ui.invitationReads(), owner ? 1 : 0, 'the owner sees join requests on opening without an extra fetch button or refresh');
        assert.match(screen.text(), /参加者/u);
        const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
        const has = title => screen.nodes().some(node => node.props.accessibilityRole === 'button' && (node.props.accessibilityLabel === title || text(node) === title));
        assert.equal(has('招待リンクとQRを作る'), owner); assert.equal(has('このメンバーを除名'), owner);
        assert.equal(has('このメンバーへ所有者を引き継ぐ'), owner);
        if (owner) {
          await screen.press('このメンバーを除名'); assert.deepEqual(ui.commands, []);
          const confirmation = ui.alerts.at(-1); assert.equal(confirmation[0], 'メンバーを除名しますか？');
          await confirmation[2].find(choice => choice.text === '除名する').onPress(); await screen.flush();
          assert.deepEqual(ui.commands, [['remove', ['member']]]);
        }
        await screen.press('グループから退出'); assert.equal(ui.commands.some(([command]) => command === 'leave'), false);
        assert.match(ui.alerts.at(-1)[1], /未送信の変更が2件/u);
      } finally { screen.unmount(); }
    }
  });

  test(`${platform} group settings show load and held-change failures outside collapsed sections and allow a safe read retry`, async () => {
    const ui = await openGroup(platform, { recordFailures: 1, requestFailures: 1, lastErrorCode: 'sharing/test-failure', heldChanges: 3 }); const { screen } = ui;
    try {
      assert.match(screen.text(), /端末の設定を読み込めません/u);
      await screen.press('もう一度読み込む'); await screen.flush();
      assert.match(screen.text(), /グループ設定/u); assert.ok(!screen.text().includes('端末の設定を読み込めません'));
      assert.match(screen.text(), /共有の同期に失敗しました/u); assert.match(screen.text(), /確認待ちの変更が3件/u);
      assert.equal(ui.syncs(), 0); assert.deepEqual(ui.commands, []);
      assert.ok(screen.nodes().filter(node => node.props.accessibilityRole === 'alert').length >= 2);
      await screen.press('メンバー・招待（2人）を開く'); await screen.flush();
      assert.match(screen.text(), /参加申請を取得できません/u); assert.ok(!screen.text().includes('参加申請はありません'));
      await screen.press('参加申請を再試行'); await screen.flush();
      assert.match(screen.text(), /参加申請はありません/u); assert.equal(ui.invitationReads(), 2);
      assert.equal(ui.refreshes(), 0); assert.deepEqual(ui.commands, []);
    } finally { screen.unmount(); }
  });
}
