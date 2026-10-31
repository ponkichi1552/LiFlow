import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate } from '../src/domain/scheduling/local-date.ts';

const repository = await import('../src/platform/storage/repository.ts');
const style = (value) => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(style)) : value ?? {};
function assertNumericStyle(node) {
  assert.ok(node, 'the actual screen must render a numeric input');
  const input = style(node.props.style);
  assert.equal(node.props.keyboardType, 'number-pad');
  assert.equal(input.padding, 0);
  assert.equal(input.lineHeight, undefined, 'paragraph line-height shifts native UITextField digits below the units');
  assert.equal(input.textAlignVertical, 'center'); assert.equal(input.textAlign, 'center');
  assert.equal(input.includeFontPadding, false); assert.ok(input.minHeight >= 44);
}

for (const platform of ['ios', 'android']) {
  test(`numeric field centers native digits and equal unit slots on ${platform}`, () => {
    let changed;
    const screen = screenHarness('src/components/number-input-field.tsx', { platform, exportName: 'NumberInputField',
      props: { prefix: '±', value: '17', accessibilityLabel: '日数', onChangeText: (value) => { changed = value; } } });
    assertNumericStyle(screen.nodes().find((node) => node.type === 'TextInput'));
    const field = screen.nodes().find((node) => node.type === 'View');
    const slots = field.children.filter((node) => node.type === 'View');
    assert.equal(slots.length, 2); assert.deepEqual(style(slots[0].props.style), style(slots[1].props.style));
    assert.equal(style(field.props.style).alignItems, 'center');
    for (const text of screen.nodes().filter((node) => node.type === 'Text')) assert.equal(style(text.props.style).lineHeight, undefined);
    screen.nodes().find((node) => node.type === 'TextInput').props.onChangeText('3650'); assert.equal(changed, '3650');
    const noPrefix = screenHarness('src/components/number-input-field.tsx', { platform, exportName: 'NumberInputField', props: { value: '2' } });
    assert.equal(noPrefix.nodes().filter((node) => node.type === 'View').length, 3, 'the leading empty slot must remain to preserve the center');
  });
}

test('individual settings and monthly waste use the shared aligned numeric control and keep save handlers', async () => {
  const h = createDatabase(); const today = localDateFromDate(new Date());
  try {
    await repository.initializeLocalDatabase(h.database);
    let snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const chore = snapshot.chores[0];
    const screen = screenHarness('src/app/chores/[id].tsx', { database: h.database, params: { id: chore.id }, snapshot: () => snapshot,
      refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); } });
    for (const name of ['家事周期の日数', '実施期間の日数幅']) assertNumericStyle(screen.nodes().find((node) => node.props.accessibilityLabel === name));
    await screen.change('家事周期の日数', '17'); await screen.change('実施期間の日数幅', '2'); await screen.endEditing('家事周期の日数');
    assert.equal(snapshot.chores.find((item) => item.id === chore.id).recommendedCycleDays, 17);
    assert.equal(snapshot.chores.find((item) => item.id === chore.id).windowRadiusDays, 2);
    const saved = [];
    const waste = screenHarness('src/features/waste/waste-schedule-editor.tsx', { exportName: 'WasteScheduleEditor', props: { onSubmit: async (value) => { saved.push(value); } } });
    await waste.change('ゴミの種類', '粗大'); await waste.press('粗大ごみを選択'); await waste.press('毎月');
    assertNumericStyle(waste.nodes().find((node) => node.props.accessibilityLabel === '毎月の収集日'));
    await waste.change('毎月の収集日', '28'); await waste.press('収集日を追加');
    assert.equal(saved[0].monthlyDay, 28);
  } finally { h.connection.close(); }
});

test('appliance analysis cycle fields use the shared aligned control and still update the saved appliance', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const task = { name: 'フィルターを洗う', recommendedIntervalDays: 30, steps: ['電源を切る'], tools: [], safetyCautions: [], evidence: [{ url: 'https://www.dyson.co.jp/support' }] };
    const verified = { status: 'verified', product: { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20' }, officialSources: { manualUrl: 'https://www.dyson.co.jp/support' },
      analysis: { manufacturer: 'Dyson', model: 'SV20', analyzedAt: new Date().toISOString(), requiresUserReview: true, tasks: [task] } };
    const screen = screenHarness('src/app/(tabs)/manual/appliance-care.tsx', { database: h.database,
      mocks: { '@/features/appliance-care/api-client': { analyzeApplianceCareRequest: async () => verified } } });
    await screen.change('メーカー名', 'Dyson'); await screen.change('製品名', 'V12'); await screen.change('型番', 'SV20'); await screen.press('取扱説明書PDFを選ぶ'); await screen.flush(); await screen.press('このPDFを利用でき、解析APIへの送信を確認した'); await screen.press('選択したPDFを解析');
    assertNumericStyle(screen.nodes().find((node) => node.props.accessibilityLabel === 'フィルターを洗うの周期'));
    await screen.change('フィルターを洗うの周期', '17'); await screen.press('周期の変更を保存');
    const snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.chores.find((chore) => chore.applianceId).userIntervalDays, 17);
  } finally { h.connection.close(); }
});
