import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

const field = ui => ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '毎月の収集日');
for (const platform of ['ios', 'android']) {
  test(`${platform} monthly waste calendar selects the actual day and the same-frame save uses it without changing the recurrence`, async () => {
    let saved;
    const ui = screenHarness('src/features/waste/waste-schedule-editor.tsx', { exportName: 'WasteScheduleEditor', platform,
      props: { initial: { id: 'oversized-waste', label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31 },
        referenceDate: '2027-02-01', onSubmit: async value => { saved = value; } } });
    assert.equal(ui.button('2027/02/28を選択').props.accessibilityState.selected, true);
    assert.equal(field(ui).props.value, '31');
    const save = ui.button('変更を保存'); ui.button('2027/02/21を選択').props.onPress(); save.props.onPress();
    for (let i = 0; i < 8; i++) await ui.flush();
    assert.equal(saved.monthlyDay, 21); assert.equal(saved.recurrence, 'monthly'); assert.deepEqual(saved.collectionWeekdays, []); assert.equal(saved.id, 'oversized-waste');
  });
  test(`${platform} viewing a shorter month highlights its last day without rewriting a monthly day 31 setting`, async () => {
    let saved;
    const ui = screenHarness('src/features/waste/waste-schedule-editor.tsx', { exportName: 'WasteScheduleEditor', platform,
      props: { initial: { label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31 },
        referenceDate: '2027-01-01', onSubmit: async value => { saved = value; } } });
    await ui.press('収集日カレンダーの次の月'); assert.equal(ui.button('2027/02/28を選択').props.accessibilityState.selected, true);
    assert.equal(field(ui).props.value, '31'); await ui.press('変更を保存'); assert.equal(saved.monthlyDay, 31);
  });
  test(`${platform} monthly waste calendar respects the editor save lock`, async () => {
    const ui = screenHarness('src/features/waste/waste-schedule-editor.tsx', { exportName: 'WasteScheduleEditor', platform,
      props: { disabled: true, initial: { label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31 },
        referenceDate: '2027-02-01', onSubmit: async () => assert.fail('disabled save') } });
    assert.equal(ui.button('2027/02/21を選択').props.disabled, true); ui.button('2027/02/21を選択').props.onPress(); await ui.flush();
    assert.equal(field(ui).props.value, '31'); assert.equal(ui.button('変更を保存').props.disabled, true);
  });
}
