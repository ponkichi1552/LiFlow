import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { screenHarness } from './helpers/screen-harness.mjs';

async function fixture(platform, { isOwner = true, enabled = true, status = null, foreign = false, removeDeviceIds = ['device-member'], restoredOriginals = 0, embedded = false } = {}) {
  const calls = []; const alerts = []; const effects = []; let saved = status ? value(status) : null;
  function value(status = 'review') { return { status, draft: { review: { id: 'review-one', groupId: foreign ? 'other-group' : 'test-group', reviewDigest: 'a'.repeat(64),
    retainedChanges: 3, restoredOriginals, unreadableChanges: 1, heldChanges: 0, removeDeviceIds, entries: [] }, preservedFacts: [] } }; }
  const recovery = { enabled, async readSummary() { calls.push(['read']); return structuredClone(saved); }, async read() { assert.fail('overview must not restore all ciphertext'); }, async prepare() { calls.push(['prepare']); saved = value(); },
    async confirm(id, digest) { calls.push(['confirm', id, digest]); saved.status = 'applied'; }, async cancel(id, digest) { calls.push(['cancel', id, digest]); saved.status = 'cancelled'; } };
  const screen = screenHarness('src/features/sharing/v2/recovery-panel.tsx', { exportName: 'V2RecoveryPanel', platform, effect: effect => effects.push(effect),
    alert: (...args) => alerts.push(args), props: { groupId: 'test-group', recovery, isOwner, devices: [{ deviceId: 'device-member', displayName: '確認するメンバー' }],
      busy: false, initiallyExpanded: !embedded, embedded, run: async work => { try { await work(); return true; } catch { return false; } } } });
  effects.slice(0, 2).forEach(effect => effect()); await screen.flush();
  return { calls, alerts, screen };
}
const consentTests = {
  ios: 'ios owner recovery previews impact and cannot confirm before acknowledgement and the final explicit alert',
  android: 'android owner recovery previews impact and cannot confirm before acknowledgement and the final explicit alert',
};
for (const platform of ['ios', 'android']) {
  test(`${platform} embedded recovery exposes the impact check without a second disclosure and never starts recovery automatically`, async () => {
    const f = await fixture(platform, { embedded: true });
    try {
      assert.equal(f.calls.some(call => call[0] !== 'read'), false);
      assert.ok(!f.screen.nodes().some(node => node.props.accessibilityLabel === '同期の復旧を開く' || node.props.accessibilityLabel === '同期の復旧を閉じる'));
      await f.screen.press('復旧の影響を検査');
      assert.equal(f.screen.button('この内容で復旧').props.disabled, true);
      assert.equal(f.calls.some(call => call[0] === 'confirm'), false);
    } finally { f.screen.unmount(); }
  });
  test(consentTests[platform], async () => {
    const f = await fixture(platform); assert.equal(f.calls.some(call => call[0] !== 'read'), false);
    await f.screen.press('復旧の影響を検査'); await f.screen.flush();
    assert.ok(f.screen.text().includes('反映する変更（復元を含む）：3件')); assert.ok(f.screen.text().includes('確認するメンバー'));
    assert.equal(f.screen.button('この内容で復旧').props.disabled, true);
    const checkbox = f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '復旧の内容と参加解除の影響を確認しました');
    assert.ok(checkbox); assert.equal(checkbox.props.accessibilityState.checked, false); checkbox.props.onPress(); await f.screen.flush();
    await f.screen.press('この内容で復旧'); assert.equal(f.alerts.length, 1); assert.equal(f.calls.some(call => call[0] === 'confirm'), false);
    const approve = f.alerts[0][2].find(button => button.text === '復旧する'); approve.onPress(); await f.screen.flush();
    assert.deepEqual(f.calls.find(call => call[0] === 'confirm'), ['confirm', 'review-one', 'a'.repeat(64)]);
    assert.ok(f.screen.text().includes('復旧済み'));
  });
  test(`${platform} exact-original recovery confirmation states that healthy devices will not be removed`, async () => {
    const f = await fixture(platform, { status: 'review', removeDeviceIds: [], restoredOriginals: 1 });
    const checkbox = f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '復旧の内容と参加解除の影響を確認しました');
    checkbox.props.onPress(); await f.screen.flush(); await f.screen.press('この内容で復旧');
    assert.match(f.alerts[0][1], /参加端末は解除せず/u);
    assert.equal(f.calls.some(call => call[0] === 'confirm'), false);
  });
  test(`${platform} a restarted confirmed recovery is displayed without automatic transmission and can be cancelled explicitly`, async () => {
    const f = await fixture(platform, { status: 'confirming' });
    assert.ok(f.screen.text().includes('確認済み・復旧の完了待ち'));
    assert.equal(f.screen.button('確認した復旧を再開').props.disabled, true);
    assert.equal(f.calls.some(call => call[0] === 'confirm'), false);
    await f.screen.press('復旧を中断する'); await f.screen.flush();
    assert.deepEqual(f.calls.find(call => call[0] === 'cancel'), ['cancel', 'review-one', 'a'.repeat(64)]);
    assert.ok(f.screen.text().includes('復旧を中断済み'));
  });
  test(`${platform} members unsupported deployments and foreign-group reviews cannot expose owner recovery controls`, async () => {
    for (const options of [{ isOwner: false }, { enabled: false }]) {
      const f = await fixture(platform, options); assert.equal(f.screen.text(), ''); assert.deepEqual(f.calls, []);
    }
    const foreign = await fixture(platform, { status: 'review', foreign: true });
    assert.equal(foreign.screen.nodes().some(node => node.props.accessibilityLabel === 'この内容で復旧'), false);
    assert.ok(foreign.screen.text().includes('保存済みの復旧確認を読み込めません'));
  });
}
test('owner recovery is wired to the explicitly selected v2 group while retained-history notices remain readable to members', () => {
  const source = readFileSync(new URL('../src/features/sharing/sharing-manager-screen.tsx', import.meta.url), 'utf8');
  assert.match(source, /workspace\.protocol === 2.*record\.status === 'active'/);
  assert.match(source, /groupId=\{workspace\.groupId\} recovery=\{workspace\.session\.recovery\}/);
  assert.match(source, /snapshot\?\.recoverySummary\?\.heldChanges/);
});
