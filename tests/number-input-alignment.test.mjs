import { withUploadedManual } from './helpers/sharing-v2-appliance.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate } from '../src/domain/scheduling/local-date.ts';

const repository = await import('../src/platform/storage/repository.ts');
for (const platform of ['ios', 'android']) test(`${platform} touching numeric field padding focuses the input and preserves its input callbacks`, async () => {
  const changes = []; const blurs = [];
  const props = { accessibilityLabel: '家事時間上限', value: '', placeholder: '上限なし', suffix: '', editIndicator: true,
    onChangeText: value => changes.push(value), onBlur: event => blurs.push(event) };
  const options = { exportName: 'NumberInputField', platform, props };
  const ui = screenHarness('src/components/number-input-field.tsx', options);
  const input = ui.nodes().find(node => node.type === 'TextInput'); let focuses = 0;
  input.props.ref.current = { focus() { focuses++; } };
  ui.nodes().find(node => node.type === 'Pressable').props.onPress();
  assert.equal(focuses, 1); assert.equal(input.props.value, '');
  await ui.change('家事時間上限', '60');
  const event = { nativeEvent: { text: '60' } };
  ui.nodes().find(node => node.type === 'TextInput').props.onBlur(event);
  assert.deepEqual(changes, ['60']); assert.deepEqual(blurs, [event]);
  options.props = { ...props, value: '60', editable: false }; ui.render();
  const locked = ui.nodes().find(node => node.type === 'TextInput');
  assert.equal(locked.props.value, '60'); assert.equal(locked.props.editable, false);
  assert.equal(locked.props.accessibilityState.disabled, true);
  assert.equal(ui.nodes().find(node => node.type === 'Pressable').props.disabled, true);
  await assert.rejects(ui.change('家事時間上限', '90'), /read-only input/);
  assert.deepEqual(changes, ['60']);
});

test('individual settings and monthly waste persist the entered cycle window and collection day', async () => {
  const h = createDatabase(); const today = localDateFromDate(new Date());
  try {
    await repository.initializeLocalDatabase(h.database);
    let snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const chore = snapshot.chores[0];
    const screen = screenHarness('src/app/chores/[id].tsx', { database: h.database, params: { id: chore.id }, snapshot: () => snapshot,
      refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); } });
    await screen.change('家事周期の日数', '17'); await screen.change('実施期間の日数幅', '2'); await screen.endEditing('家事周期の日数');
    assert.equal(snapshot.chores.find((item) => item.id === chore.id).recommendedCycleDays, 17);
    assert.equal(snapshot.chores.find((item) => item.id === chore.id).windowRadiusDays, 2);
    const saved = [];
    const waste = screenHarness('src/features/waste/waste-schedule-editor.tsx', { exportName: 'WasteScheduleEditor', props: { onSubmit: async (value) => { saved.push(value); } } });
    await waste.change('ゴミの種類', '粗大'); await waste.press('粗大ごみを選択'); await waste.press('毎月');
    await waste.change('毎月の収集日', '28'); await waste.press('収集日を追加');
    assert.equal(saved[0].monthlyDay, 28);
  } finally { h.connection.close(); }
});

test('appliance analysis cycle edits update the saved appliance', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const task = { name: 'フィルターを洗う', recommendedIntervalDays: 30, steps: ['電源を切る'], tools: [], safetyCautions: [], evidence: [{ url: 'https://www.dyson.co.jp/support' }] };
    const verified = { status: 'verified', product: { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20' }, officialSources: { manualUrl: 'https://www.dyson.co.jp/support' },
      analysis: { manufacturer: 'Dyson', model: 'SV20', analyzedAt: new Date().toISOString(), requiresUserReview: true, tasks: [task] } };
    const screen = screenHarness('src/app/(tabs)/manual/appliance-care.tsx', { database: h.database,
      mocks: { '@/features/appliance-care/api-client': { analyzeApplianceCareRequest: async request => withUploadedManual(verified, request.manual) } } });
    await screen.press('取扱説明書PDFを選ぶ'); await screen.flush(); await screen.press('PDFを解析');
    await screen.change('フィルターを洗うの周期', '17'); await screen.press('周期の変更を保存');
    const snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.chores.find((chore) => chore.applianceId).userIntervalDays, 17);
  } finally { h.connection.close(); }
});
