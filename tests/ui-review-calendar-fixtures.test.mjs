import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

const filename = 'src/features/development/ui-review/calendar-review.tsx';
const make = (scenario, options) => screenHarness(filename, { exportName: 'CalendarReview', props: { scenario }, ...options });
const controls = (ui, label) => ui.nodes().filter(node => node.props.accessibilityLabel === label);
const sourceHints = (ui, label) => controls(ui, label).map(node => node.props.accessibilityHint);
const descendants = node => (node.children ?? []).flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []);
const mirror = '洗面所の鏡を拭くの今回の日付を変更';
const filter = 'リビングと寝室のエアコンのフィルターと吹き出し口を順番に掃除する';

for (const scenario of ['three', 'week']) test(`${scenario} review opens mixed-source chores and reschedules only the selected fixture occurrence`, async t => {
  const ui = make(scenario);
  t.after(() => ui.unmount());
  assert.equal(ui.button('2026年11月23日の家事を閉じる').props.accessibilityState.expanded, true);
  assert.deepEqual(sourceHints(ui, mirror).map(hint => hint.split('。')[0]).sort(), ['個人の家事', '共有の家事']);

  const edit = `${filter}の今回の日付を変更`;
  const contents = descendants(ui.button(edit));
  const labels = contents.filter(node => node.type === 'Text');
  assert.deepEqual(labels.map(node => node.children.join('')), [filter]);
  assert.equal(labels[0].props.numberOfLines, 1);
  assert.equal(labels[0].props.ellipsizeMode, 'tail');
  assert.equal(contents.some(node => node.type === 'SymbolView' || node.type === 'Svg'), false);
  await ui.press(edit);
  await ui.press('2026/11/24を選択');
  await ui.press('今回の実施日を保存');
  assert.equal(controls(ui, edit).length, 0);
  await ui.press('2026年11月24日の家事を開く');
  assert.equal(controls(ui, edit).length, 1);
  await ui.press('2026年11月24日の家事を閉じる');
  assert.equal(controls(ui, edit).length, 0);

  const fresh = make(scenario);
  t.after(() => fresh.unmount());
  assert.equal(controls(fresh, edit).length, 1);
});

test('calendar review searches fixture memos, inspects personal and shared events, and keeps device preferences isolated', async t => {
  const access = [];
  const ui = make('list', { platform: 'android', navigate: method => access.push(method),
    mocks: { 'expo-sqlite/kv-store': { __esModule: true, default: {
      getItemSync: key => { access.push(key); return null; }, setItemSync: key => access.push(key),
    } } } });
  t.after(() => ui.unmount());
  assert.match(ui.text(), /勤労感謝の日/u);
  assert.match(ui.text(), /古紙/u);
  ui.button('自分の誕生日を編集');
  await ui.press('家族の旅行と帰省を編集');
  assert.match(ui.text(), /共有 · 家族の予定/u);
  assert.match(ui.text(), /11月22日.*11月25日.*終日/u);
  await ui.press('詳細を閉じる');
  await ui.press('予定を検索する');
  await ui.change('予定を検索', '筆記具');
  const result = ui.nodes().find(node => node.props.accessibilityLabel?.includes('写真展') && node.props.accessibilityLabel.endsWith('の検索結果を開く'));
  assert.ok(result);
  await ui.press(result.props.accessibilityLabel);
  const appointment = ui.nodes().find(node => node.props.accessibilityLabel?.includes('写真展') && node.props.accessibilityLabel.endsWith('を編集'));
  assert.ok(appointment);
  await ui.press(appointment.props.accessibilityLabel);
  assert.match(ui.text(), /個人 · 学校/u);
  assert.match(ui.text(), /午後のワークショップ用の用紙と筆記具/u);
  await ui.press('詳細を閉じる');
  await ui.press('カレンダーの表示を選択');
  const shortening = controls(ui, '予定名の日時表現を省略')[0];
  assert.ok(shortening);
  shortening.props.onPress();
  await ui.flush();
  assert.deepEqual(access, []);
});

test('partial calendar shows only available chores and empty calendar has no fixture results', async t => {
  const partial = make('partial');
  const empty = make('empty');
  t.after(() => { partial.unmount(); empty.unmount(); });
  assert.match(partial.text(), /個人家事は未取得/u);
  assert.deepEqual(sourceHints(partial, mirror).map(hint => hint.split('。')[0]), ['共有の家事']);
  await partial.press('2026年11月24日の家事を開く');
  assert.ok(sourceHints(partial, mirror).some(hint => hint.startsWith('個人の家事')));
  assert.doesNotMatch(partial.text(), /この日の個人家事は未取得/u);
  assert.match(empty.text(), /予定なし/u);
  assert.equal(empty.nodes().some(node => node.props.accessibilityLabel?.includes('日の家事を開く')), false);
  await empty.press('予定を検索する');
  await empty.change('予定を検索', '洗面所');
  assert.match(empty.text(), /一致する予定はありません/u);
});

test('the midnight overlap review can open each of the three continuing entries and return with one back action', async t => {
  let exits = 0;
  const ui = make('overlap', { props: { scenario: 'overlap', onExit: () => { exits++; } } });
  t.after(() => ui.unmount());
  assert.equal(ui.button('2026年11月23日の家事を開く').props.accessibilityState.expanded, false);
  for (const name of ['夜行列車で移動', '前夜から翌々朝までのキャンプ当番', '洗濯乾燥機のフィルターを確認する']) {
    assert.ok(ui.button(`${name}を編集`));
    await ui.press(`${name}を編集`);
    assert.ok(ui.button('詳細を閉じる'));
    await ui.press('詳細を閉じる');
  }
  await ui.press('UI確認用データ一覧へ戻る');
  assert.equal(exits, 1);
});
