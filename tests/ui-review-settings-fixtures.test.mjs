import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { plannerReadRetryDelays } from '../src/platform/storage/planner-read-retry.ts';

function open(t, name, exportName, scenario) {
  const ui = screenHarness(`src/features/development/ui-review/${name}.tsx`, { exportName,
    props: { scenario, onExit() {} }, effectDependencies: true, effect: callback => callback() });
  t.after(() => ui.unmount());
  return ui;
}

test('first-run fixture can recover a display failure after the setup has been saved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = open(t, 'setup-review', 'SetupReview', 'first-reopen');
  assert.match(ui.button('時間帯・上限を変更').props.accessibilityValue.text, /休日以外、19–21時/u);
  await ui.press('設定して始める');
  assert.match(ui.text(), /家事を読み込んでいます/u);
  assert.doesNotMatch(ui.text(), /再読込/u);
  t.mock.timers.tick(plannerReadRetryDelays[0]); await ui.flush();
  assert.match(ui.text(), /今日の家事/u);
});

test('chore search retains the query after returning from the guide', async t => {
  const ui = open(t, 'chore-review', 'ChoreReview', 'library-match');
  const result = ui.nodes().find(node => node.props.accessibilityLabel?.endsWith('の説明を開く'));
  assert.ok(result);
  await ui.press(result.props.accessibilityLabel);
  assert.match(ui.text(), /手順/u);
  await ui.press('家事一覧に戻る');
  assert.equal(ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '家事名を検索').props.value, '洗濯');
  await ui.change('家事名を検索', 'ハンダ付け');
  assert.match(ui.text(), /一致する家事はありません/u);
});

test('group fixtures expose the member’s date reply and only the management device can invite', async t => {
  const member = open(t, 'group-review', 'GroupReview', 'group-member');
  assert.ok(!member.nodes().some(node => node.props.accessibilityLabel === '要確認'));
  await member.press('日時・担当変更の申請');
  await member.press('日時変更を承認');
  assert.match(member.text(), /回答を端末に保存/u);

  const secondary = open(t, 'group-review', 'GroupReview', 'group-secondary');
  await secondary.press('要確認');
  await secondary.press('代行の実施を承認');
  assert.match(secondary.text(), /確認が必要な項目はありません/u);
  await secondary.press('グループ設定に戻る');
  await secondary.press('メンバー・招待');
  assert.ok(!secondary.nodes().some(node => node.props.accessibilityLabel === '招待リンクとQRを作る'));

  const owner = open(t, 'group-review', 'GroupReview', 'group-owner');
  await owner.press('メンバー・招待');
  await owner.press('招待リンクとQRを作る');
  assert.match(owner.text(), /12月31日 20:00まで/u);
});

test('waste fixture can restore a hidden occurrence and undo changes within its own sample', async t => {
  const ui = open(t, 'waste-review', 'WasteReview', 'waste-hidden');
  assert.match(ui.text(), /非表示の収集日/u);
  await ui.press('再表示');
  assert.doesNotMatch(ui.text(), /非表示の収集日/u);
  await ui.press('12月30日・びん・缶を元に戻す');
  assert.match(ui.text(), /非表示の収集日/u);
});
