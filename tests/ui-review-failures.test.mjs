import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

function openReview(t, scenario, platform) {
  const deviceCalls = [];
  const external = name => () => {
    deviceCalls.push(name);
    throw new Error('The UI review accessed ' + name);
  };
  const props = { scenario };
  const ui = screenHarness('src/features/development/ui-review/failure-review.tsx', {
    platform, exportName: 'FailureReview', props,
    effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(),
    mocks: {
      'expo-sqlite/kv-store': { __esModule: true, default: { getItemSync: external('device storage'), setItemSync: external('device storage') } },
      '../../platform/notifications/notification-settings': { openDeviceNotificationSettings: external('device settings') },
      '../../platform/notifications/expo-local-notification-gateway': {
        expoLocalNotificationGateway: { hasPermission: external('device permission'), requestPermission: external('device permission') },
      },
    },
  });
  t.after(() => { ui.unmount(); assert.deepEqual(deviceCalls, []); });
  return { ui, changeScenario: next => { props.scenario = next; ui.render(); } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} review search distinguishes unread history, partial results and an actual zero, and resets on reopening`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { ui, changeScenario } = openReview(t, 'search-history', platform);
    const settleSearch = async () => { t.mock.timers.tick(200); await ui.flush(); };
    assert.match(ui.text(), /過去の予定を検索中/);
    await settleSearch();
    assert.match(ui.text(), /保存履歴を検索できませんでした/);
    assert.doesNotMatch(ui.text(), /一致する予定はありません/);
    await ui.press('検索を再試行'); await settleSearch();
    ui.button('給湯器の点検の検索結果を開く');

    changeScenario('search-partial'); await settleSearch();
    ui.button('火災報知器の点検の検索結果を開く');
    assert.match(ui.text(), /保存履歴を検索できませんでした/);
    assert.doesNotMatch(ui.text(), /給湯器/);
    await ui.press('検索を再試行'); await settleSearch();
    ui.button('火災報知器の点検の検索結果を開く');
    await ui.press('給湯器の点検の検索結果を開く');
    if (platform === 'ios') { ui.nodes().find(node => node.type === 'Modal').props.onDismiss(); await ui.flush(); }
    assert.match(ui.text(), /給湯器の点検/);
    await ui.press('最初の状態で検索を開く'); await settleSearch();
    assert.match(ui.text(), /保存履歴を検索できませんでした/);

    changeScenario('search-empty');
    assert.match(ui.text(), /一致する予定はありません/);
    assert.doesNotMatch(ui.text(), /保存履歴を検索できませんでした/);
    await ui.change('予定を検索', '給湯器');
    ui.button('給湯器の点検の検索結果を開く');
  });

  test(`${platform} review notification denial preserves the app preference and simulates either return from settings`, async t => {
    const { ui } = openReview(t, 'notification-denied', platform);
    const checkbox = () => ui.nodes().find(node => node.props.accessibilityRole === 'checkbox');
    assert.equal(checkbox().props.accessibilityState.checked, true);
    assert.match(ui.text(), /端末の通知がオフ/);
    await ui.press('端末の設定を開く'); await ui.press('許可せず戻る');
    assert.equal(checkbox().props.accessibilityState.checked, true);
    assert.match(ui.text(), /端末の通知がオフ/);
    checkbox().props.onPress(); await ui.flush();
    assert.equal(checkbox().props.accessibilityState.checked, false);
    checkbox().props.onPress(); await ui.flush();
    assert.equal(checkbox().props.accessibilityState.checked, false);
    await ui.press('端末の設定を開く'); await ui.press('許可して戻る');
    assert.equal(checkbox().props.accessibilityState.checked, true);
    assert.doesNotMatch(ui.text(), /端末の通知がオフ/);
  });

  test(`${platform} review Google sync retries its read and requires a dummy account confirmation to recover authorization`, async t => {
    const { ui, changeScenario } = openReview(t, 'sync-read', platform);
    await ui.flush();
    assert.match(ui.text(), /共有家事の接続状態を読み込めませんでした/);
    await ui.press('Google連携を再読込'); await ui.flush();
    assert.match(ui.text(), /連携中/);
    changeScenario('sync-auth'); await ui.flush();
    assert.match(ui.text(), /アカウントの確認が必要/);
    await ui.press('共有家事を今すぐ同期');
    assert.match(ui.text(), /送信待ちは保持/);
    await ui.press('Googleアカウントを確認'); await ui.press('このアカウントで連携');
    assert.match(ui.text(), /更新1件/);
    assert.doesNotMatch(ui.text(), /アカウントの確認が必要/);
  });

  test(`${platform} review startup hands both retry and the held loading state to the populated home fixture`, async t => {
    const { ui, changeScenario } = openReview(t, 'home-read', platform);
    assert.match(ui.text(), /データを読み込めませんでした/);
    await ui.press('もう一度読み込む');
    assert.match(ui.text(), /ひより荘（サンプル）/);
    changeScenario('home-loading');
    assert.match(ui.text(), /今日の家事を読み込んでいます/);
    await ui.press('テストデータの読み込みを完了');
    assert.match(ui.text(), /ひより荘（サンプル）/);
  });
}
