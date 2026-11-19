import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

const file = 'src/features/development/ui-review/appliance-review.tsx';
const goodPdf = '見本_QA-MIST-02_取扱説明書.pdf';

function openPreview(t, platform, scenario) {
  const props = { scenario };
  const externalCalls = [];
  const unexpected = action => () => { externalCalls.push(action); throw new Error(action); };
  const screen = screenHarness(file, {
    platform, props, exportName: 'ApplianceReview', effectDependencies: true,
    effect: callback => callback(), layoutEffect: callback => callback(), navigate: unexpected('router'),
    mocks: {
      'expo-document-picker': { getDocumentAsync: unexpected('system picker') },
      '@/features/appliance-care/api-client': { analyzeApplianceCareRequest: unexpected('analysis service') },
      '@/features/appliance-care/ai-account': { ApplianceAiAccount: unexpected('account') },
      '@/hooks/use-planner-data': { usePlannerData: unexpected('personal planner') },
      '@/platform/storage/appliance-manuals': { readApplianceManual: unexpected('saved PDF') },
    },
  });
  t.after(() => { screen.unmount(); assert.deepEqual(externalCalls, []); });
  return { screen, switchTo(next) { props.scenario = next; screen.render(); } };
}

async function check(screen, label) {
  const node = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label);
  assert.ok(node, label);
  node.props.onPress();
  await screen.flush();
}

for (const platform of ['ios', 'android']) {
  test(`${platform} appliance review opens scoped fixtures, long manuals and an empty legacy record`, async t => {
    const { screen, switchTo } = openPreview(t, platform, 'library');
    await screen.press('扇風機、書斎の卓上ファンのお手入れを開く（個人）');
    assert.match(screen.text(), /7日ごと/u);
    assert.match(screen.text(), /メーカー推奨：14日/u);
    await screen.press('家電一覧へ戻る');
    assert.match(screen.text(), /4台/u);
    switchTo('dense-library');
    const rows = screen.nodes().find(node => node.type === 'FlatList').props.data;
    assert.equal(rows.length, 16);
    assert.equal(new Set(rows.map(row => row.id)).size, 16);
    switchTo('partial');
    assert.match(screen.text(), /個人の家電は未取得/u);
    assert.ok(screen.nodes().find(node => node.type === 'FlatList').props.data.every(row => row.source === 'shared'));
    switchTo('many');
    await screen.press('保管袋のラベルを確認するへ移動');
    assert.match(screen.text(), /保管する本体と袋の型番を照らし合わせる/u);
    switchTo('no-care');
    assert.match(screen.text(), /お手入れ 0項目/u);
    assert.doesNotMatch(screen.text(), /説明書を開く/u);
    await screen.press('この家電を再解析');
    await screen.press('取扱説明書PDFを選ぶ');
    await screen.press('見本_QA-KETTLE-0_取扱説明書.pdf');
    await screen.press('PDFを再解析');
    assert.match(screen.text(), /お手入れ 1項目/u);
    assert.match(screen.text(), /水位窓を確認する/u);
    await screen.press('戻る');
    assert.match(screen.text(), /お手入れ方法/u);
    assert.match(screen.text(), /お手入れ 1項目/u);
  });

  test(`${platform} unreadable appliance sample retries locally and retains only the chosen shared task`, async t => {
    const { screen, switchTo } = openPreview(t, platform, 'manual-error');
    assert.match(screen.text(), /文字を読み取れませんでした/u);
    assert.doesNotMatch(screen.text(), /PDFを解析/u);
    await screen.press('PDFを変更');
    await screen.press(goodPdf);
    assert.doesNotMatch(screen.text(), /文字を読み取れませんでした/u);
    await screen.press('PDFを解析');
    assert.equal(screen.button('確認した解析結果を共有する').props.disabled, true);
    await screen.press('水量表示を確認するへ移動');
    await check(screen, '「水量表示を確認する」を無効の共有家事として追加');
    await check(screen, 'メーカー・型番・手順・注意事項を確認した');
    await screen.press('確認した解析結果を共有する');
    await screen.press('家電の操作へ移動');
    assert.match(screen.text(), /登録した共有家事水量表示を確認する/u);
    await screen.press('家電一覧へ戻る');
    await screen.press('加湿器、談話室の加湿器のお手入れを開く（グループ）');
    assert.match(screen.text(), /お手入れ方法/u);
    await screen.press('この共有家電を再解析');
    await screen.press('取扱説明書PDFを選ぶ');
    await screen.press(goodPdf);
    await screen.press('PDFを再解析');
    await check(screen, 'メーカー・型番・手順・注意事項を確認した');
    await screen.press('確認した解析結果を共有する');
    assert.match(screen.text(), /登録した共有家事水量表示を確認する/u);
    switchTo('review');
    assert.equal(screen.button('確認した解析結果を共有する').props.disabled, true);
    assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityState.checked).length, 0);
  });

  test(`${platform} empty private appliance preview adds a sample, validates cycles and resets on reentry`, async t => {
    const { screen, switchTo } = openPreview(t, platform, 'empty');
    assert.match(screen.text(), /未登録/u);
    await screen.press('家電を追加');
    assert.equal(screen.button('PDFを解析').props.disabled, true);
    await screen.press('取扱説明書PDFを選ぶ');
    await screen.press(goodPdf);
    await screen.press('PDFを解析');
    await screen.change('タンクの外側を拭くの周期', '0');
    await screen.press('周期の変更を保存');
    assert.match(screen.text(), /1〜3650日の整数/u);
    await screen.change('タンクの外側を拭くの周期', '１２');
    await screen.press('周期の変更を保存');
    assert.match(screen.text(), /12日ごと/u);
    await screen.press('水量表示を確認するへ移動');
    assert.match(screen.text(), /定期予定なし/u);
    await screen.press('家電一覧へ戻る');
    assert.match(screen.text(), /1台/u);
    switchTo('single');
    switchTo('empty');
    assert.match(screen.text(), /未登録/u);
  });
}
