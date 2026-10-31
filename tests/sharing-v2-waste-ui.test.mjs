import { openCalendarDay } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { loadSharedFacts, applyReceivedSharedFacts, readSharingCheckpoint, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { wasteTypeColor } from '../src/features/waste/type-appearance.ts';
const day = '2026-10-27'; const range = { from: day, through: '2026-11-10', asOfDate: day };
const weekly = { label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [2] };
const ids = field => field.candidates.map(candidate => candidate.operationId);
const rule = value => ({ recurrence: value.recurrence, collectionWeekdays: value.collectionWeekdays, anchorDate: value.anchorDate ?? null, monthlyDay: value.monthlyDay ?? null });
const checkbox = (screen, hidden = false, label = '可燃ごみ') => screen.nodes().find(node => node.props.accessibilityRole === 'checkbox'
  && node.props.accessibilityLabel === `${label}の${day}のゴミ出しを${hidden ? '再表示' : '非表示'}`);
async function settle(screen, predicate) { for (let n = 0; n < 45 && !predicate(); n++) await screen.flush(); assert.ok(predicate(), screen.text()); }
async function receive(device, facts) { const checkpoint = await readSharingCheckpoint(device.database, groupId);
  await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, checkpoint.cursor, now().getTime(), device.repository.evidenceForServerReceipts(receiptsFor(facts))); }
function controller(device) { let n = 0; return createV2GroupController(device.repository, { makeId: () => `waste-ui-${device.options.userId}-${++n}`, now, sync: async () => {} }); }
async function setup() {
  const base = await fixture(); const owner = await base.device(); await owner.repository.commit(seeds()); const c = controller(owner);
  let failAfterAdd = false; let failRead = false; let preferences = 0; const mounted = [];
  const decorated = { ...c, actions: { ...c.actions, addWasteSchedule: async value => { const result = await c.actions.addWasteSchedule(value); if (failAfterAdd) { failRead = true; failAfterAdd = false; } return result; } } };
  const source = createV2ScreenSession({ controller: decorated, groupId, userId: 'owner', now,
    readPreferences: () => { preferences++; return { ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }; } });
  const session = { ...source, readModel: async options => { if (failRead) { failRead = false; throw new Error('injected view failure'); } return source.readModel(options); } };
  async function mount(platform, view = 'waste') {
    let focus; const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
      props: { purpose: 'workspace', view, loadSession: async () => session, onBack() {}, onConfiguration() {}, onHistory() {} }, focusEffect: callback => { focus = callback; } });
    const leave = focus(); mounted.push(leave);
    await settle(screen, () => view === 'calendar' ? screen.nodes().some(node => node.props.testID === 'calendar-weeks') : screen.text().includes(view === 'waste' ? '登録した収集日' : '今日の家事'));
    return screen;
  }
  return { base, owner, c, mount, failAfterNextAdd: () => { failAfterAdd = true; }, preferences: () => preferences,
    read: () => c.readModel(range, { waste: true }), close: () => { mounted.forEach(leave => leave()); owner.connection.close(); } };
}
async function selectType(screen, query, label) { await screen.change('ゴミの種類', query); await screen.press(`${label}を選択`); }
for (const platform of ['ios', 'android']) {
  test(`${platform} shared waste management registers all recurrence modes with the group date and never reads private planning`, async () => {
    const f = await setup();
    try {
      const screen = await f.mount(platform); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      assert.match(screen.text(), /グループ全員に共有/u); assert.equal(f.preferences(), 0);
      for (const [mode, query, label] of [['毎週', 'かねん', '可燃ごみ'], ['隔週', 'びん', 'びん'], ['毎月', 'そだい', '粗大ごみ']]) {
        await screen.press('共有の収集日を追加'); await selectType(screen, query, label);
        if (mode !== '毎週') await screen.press(mode);
        if (mode === '毎月') await screen.change('毎月の収集日', '31'); else await screen.press('火曜');
        await screen.press('収集日を追加'); await settle(screen, () => !screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === 'ゴミの種類'));
      }
      const value = await f.read(); const fortnight = value.waste.schedules.find(entry => entry.label === 'びん');
      assert.equal(fortnight.recurrence, 'biweekly'); assert.equal(fortnight.anchorDate, day);
      assert.equal(value.waste.schedules.find(entry => entry.label === '粗大ごみ').monthlyDay, 31);
      assert.equal(value.waste.schedules.length, 3); assert.equal(f.preferences(), 0);
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before + 3);
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'checkbox'), false);
      await screen.press('次の収集日を開く'); assert.ok(screen.nodes().some(node => node.props.accessibilityRole === 'checkbox'));
      await screen.press('次の収集日を閉じる'); assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'checkbox'), false);
    } finally { f.close(); }
  });

  test(`${platform} shared home hides one waste occurrence and its compact calendar checkbox restores the same date without changing chores`, async () => {
    const f = await setup();
    try {
      await f.c.actions.addWasteSchedule(weekly); const before = await f.read(); const home = await f.mount(platform, 'home');
      const list = home.nodes().find(node => node.type === 'FlatList'); const todayRows = list.props.data.filter(row => row.kind === 'today').map(row => row.item);
      assert.equal(todayRows[0].source, 'waste'); assert.equal(todayRows[1].source, 'shared');
      assert.ok(checkbox(home)); await checkbox(home).props.onPress(); await settle(home, () => !checkbox(home));
      const hidden = await f.read();
      for (const field of ['chores', 'occurrences', 'history', 'policy', 'commonSettings']) assert.deepEqual(hidden.plan[field], before.plan[field]);
      assert.equal(hidden.waste.occurrences.filter(entry => entry.hidden).length, 1);
      assert.equal(hidden.waste.occurrences.find(entry => entry.occurrence.date === '2026-11-03').hidden, false);
      const calendar = await f.mount(platform, 'calendar');
      const date = calendar.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith('2026年10月27日'));
      assert.ok(date.props.style.some(style => style?.backgroundColor)); assert.ok(date.props.style.some(style => style?.flex === 1));
      await openCalendarDay(calendar, day); const checked = checkbox(calendar, true); assert.ok(checked); assert.equal(checked.props.accessibilityState.checked, true);
      const compact = calendar.nodes().find(node => node.type === 'View' && Array.isArray(node.props.style) && node.props.style.some(style => style?.minHeight === 56)); assert.ok(compact);
      assert.ok(calendar.nodes().some(node => node.type === 'Text' && node.children.join('') === '可燃' && node.props.style.some(style => style?.color === wasteTypeColor('可燃ごみ'))));
      await checked.props.onPress(); await settle(calendar, () => Boolean(checkbox(calendar)) && !checkbox(calendar, true));
      assert.equal((await f.read()).waste.occurrences.find(entry => entry.occurrence.date === day).hidden, false);
      assert.ok(checkbox(await f.mount(platform, 'home')));
    } finally { f.close(); }
  });

  test(`${platform} shared calendar waste labels keep type marks and aligned grid cells while task counts exclude collections`, async () => {
    const f = await setup();
    try {
      await f.c.actions.addWasteSchedule({ label: '粗大ゴみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 27 });
      await f.c.actions.addWasteSchedule({ label: 'びん', recurrence: 'biweekly', collectionWeekdays: [2], anchorDate: day });
      const screen = await f.mount(platform, 'calendar');
      const cell = screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith('2026年10月27日'));
      assert.match(cell.props.accessibilityLabel, /未完了の共有家事1件/u); assert.ok(cell.props.style.some(style => style?.flex === 1));
      const nextCell = screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith('2026年10月29日'));
      const selectedStyle = Object.assign({}, ...cell.props.style.filter(Boolean)); const nextStyle = Object.assign({}, ...nextCell.props.style.filter(Boolean));
      assert.equal(selectedStyle.padding, nextStyle.padding, 'waste labels never shift the common date baseline');
      const captions = screen.nodes().filter(node => node.type === 'Text' && Array.isArray(node.props.style));
      assert.ok(captions.some(node => node.children.join('') === '粗大' && node.props.style.some(style => style?.color === wasteTypeColor('粗大ゴみ'))));
      assert.ok(captions.filter(node => node.children.join('') === '粗大').every(node => !/[ごゴ][みミ]/u.test(node.children.join(''))));
      await openCalendarDay(screen, day);
      const checks = screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox');
      assert.equal(checks.length, 3); assert.match(checks[0].props.accessibilityLabel, /ゴミ出し/u); assert.match(checks.at(-1).props.accessibilityLabel, /床を掃除/u);
      assert.equal((await f.read()).waste.schedules.find(row => row.label === '粗大ゴみ').label, '粗大ゴみ');
    } finally { f.close(); }
  });

  test(`${platform} an open shared waste form changes only edited values and refuses a newer same-field overwrite`, async () => {
    const f = await setup();
    try {
      await f.c.actions.addWasteSchedule(weekly); const base = (await f.read()).waste.rows[0]; const screen = await f.mount(platform);
      await screen.press('「可燃ごみ」の共有収集日を編集');
      await f.c.actions.editWasteSchedule(base.id, [{ field: 'rule', value: rule({ recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 28 }), basisOperationIds: ids(base.fields.rule) }]);
      await selectType(screen, 'しげん', '資源ごみ'); await screen.press('変更を保存');
      await settle(screen, () => !screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === 'ゴミの種類'));
      let row = (await f.read()).waste.rows[0]; assert.equal(row.schedule.recurrence, 'monthly'); assert.equal(row.schedule.monthlyDay, 28); assert.equal(row.label, '資源ごみ');
      await screen.press('「資源ごみ」の共有収集日を編集');
      await f.c.actions.editWasteSchedule(row.id, [{ field: 'label', value: '缶', basisOperationIds: ids(row.fields.label) }]);
      const before = await listSharingOutbox(f.owner.database, groupId);
      await selectType(screen, 'びん', 'びん'); await screen.press('変更を保存'); await settle(screen, () => screen.text().includes('別の変更が届いています'));
      row = (await f.read()).waste.rows[0]; assert.equal(row.label, '缶'); assert.deepEqual(await listSharingOutbox(f.owner.database, groupId), before);
      assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === 'ゴミの種類').props.value, 'びん');
    } finally { f.close(); }
  });

  test(`${platform} a durable shared waste addition survives a failed refresh and retries only its read without creating another schedule`, async () => {
    const f = await setup();
    try {
      const screen = await f.mount(platform); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await screen.press('共有の収集日を追加'); await selectType(screen, 'かねん', '可燃ごみ'); await screen.press('火曜');
      f.failAfterNextAdd(); const save = screen.button('収集日を追加'); save.props.onPress(); save.props.onPress();
      await settle(screen, () => screen.text().includes('端末に保存済みです'));
      assert.equal((await f.read()).waste.schedules.length, 1); assert.equal(screen.button('共有の収集日を追加').props.accessibilityState.disabled, true);
      assert.equal(screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === 'ゴミの種類'), false);
      await screen.press('保存済みの収集日を再読込'); await settle(screen, () => !screen.text().includes('端末に保存済みです'));
      assert.equal((await f.read()).waste.schedules.length, 1); assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before + 1);
    } finally { f.close(); }
  });

  test(`${platform} shared waste conflicts reveal whole candidates only on request and reject an obsolete resolution button`, async () => {
    const f = await setup(); const member = await f.base.device('member', f.base.member);
    try {
      await f.c.actions.addWasteSchedule(weekly); await receive(member, await loadSharedFacts(f.owner.database, groupId)); const b = controller(member);
      const base = (await f.read()).waste.rows[0];
      await f.c.actions.editWasteSchedule(base.id, [{ field: 'rule', value: rule({ recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 15 }), basisOperationIds: ids(base.fields.rule) }]);
      await b.actions.editWasteSchedule(base.id, [{ field: 'rule', value: rule({ recurrence: 'biweekly', collectionWeekdays: [2], anchorDate: day }), basisOperationIds: ids(base.fields.rule) }]);
      await receive(f.owner, await loadSharedFacts(member.database, groupId)); const screen = await f.mount(platform);
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button' && node.children?.join('') === '候補1で収集ルールを解決'), false);
      await screen.press(`${base.id}のruleの候補1を確認`); const obsolete = screen.button('候補1で収集ルールを解決');
      let row = (await f.read()).waste.rows[0]; const chosen = row.fields.rule.candidates[1].value;
      await f.c.actions.editWasteSchedule(row.id, [{ field: 'rule', value: chosen, basisOperationIds: ids(row.fields.rule), resolveOperationIds: ids(row.fields.rule) }]);
      const before = await listSharingOutbox(f.owner.database, groupId); await obsolete.props.onPress();
      await settle(screen, () => !screen.text().includes('収集ルールの候補'));
      row = (await f.read()).waste.rows[0]; assert.equal(row.schedule.recurrence, chosen.recurrence); assert.deepEqual(await listSharingOutbox(f.owner.database, groupId), before);
      assert.match(screen.text(), /別の変更が届いています/u);
    } finally { member.connection.close(); f.close(); }
  });

  test(`${platform} an unresolved shared waste hide decision keeps its checkbox disabled until an explicit current choice`, async () => {
    const f = await setup(); const member = await f.base.device('member', f.base.member);
    try {
      await f.c.actions.addWasteSchedule(weekly); let entry = (await f.read()).waste.occurrences[0]; await f.c.actions.setWasteOccurrenceHidden(entry.selection, true);
      await receive(member, await loadSharedFacts(f.owner.database, groupId)); const b = controller(member);
      await f.c.actions.setWasteOccurrenceHidden((await f.read()).waste.occurrences[0].selection, false);
      await b.actions.setWasteOccurrenceHidden((await b.readModel(range, { waste: true })).waste.occurrences[0].selection, false);
      await b.actions.setWasteOccurrenceHidden((await b.readModel(range, { waste: true })).waste.occurrences[0].selection, true);
      await receive(f.owner, await loadSharedFacts(member.database, groupId)); const screen = await f.mount(platform, 'home');
      assert.equal(checkbox(screen).props.accessibilityState.disabled, true); assert.match(screen.text(), /表示と非表示の変更が重なりました/u);
      await screen.press('この収集日を表示する'); await settle(screen, () => checkbox(screen)?.props.accessibilityState.disabled === false);
      entry = (await f.read()).waste.occurrences[0]; assert.equal(entry.hidden, false);
    } finally { member.connection.close(); f.close(); }
  });

  test(`${platform} shared waste editing saves the latest numeric input even when its enabled save handler ran before another paint`, async () => {
    const f = await setup();
    try {
      await f.c.actions.addWasteSchedule({ label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 28 });
      const screen = await f.mount(platform); await screen.press('「粗大ごみ」の共有収集日を編集');
      const save = screen.button('変更を保存'); const input = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '毎月の収集日');
      input.props.onChangeText('17'); save.props.onPress();
      await settle(screen, () => !screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === 'ゴミの種類'));
      assert.equal((await f.read()).waste.schedules[0].monthlyDay, 17);
    } finally { f.close(); }
  });

  test(`${platform} a shared deletion conflict needs a reviewed restoration form and removing the schedule still keeps its signed history`, async () => {
    const f = await setup(); const member = await f.base.device('member', f.base.member);
    try {
      await f.c.actions.addWasteSchedule(weekly); await receive(member, await loadSharedFacts(f.owner.database, groupId)); const b = controller(member);
      const base = (await f.read()).waste.rows[0]; await f.c.actions.deleteWasteSchedule(base.id, base.revision);
      await b.actions.editWasteSchedule(base.id, [{ field: 'label', value: '資源ごみ', basisOperationIds: ids(base.fields.label) }]);
      await receive(f.owner, await loadSharedFacts(member.database, groupId)); const screen = await f.mount(platform);
      const before = await listSharingOutbox(f.owner.database, groupId);
      await screen.press('「資源ごみ」を残す内容を確認'); assert.match(screen.text(), /入力した内容で表示中の競合を解決/u);
      assert.deepEqual(await listSharingOutbox(f.owner.database, groupId), before);
      await screen.press('変更を保存'); await settle(screen, () => !screen.text().includes('削除と編集が重なっています'));
      assert.equal((await f.read()).waste.schedules[0].label, '資源ごみ');
      await screen.press('「資源ごみ」の共有収集日を削除'); const beforeDelete = await listSharingOutbox(f.owner.database, groupId);
      assert.match(screen.text(), /グループ全員の予定から削除/u); assert.deepEqual(await listSharingOutbox(f.owner.database, groupId), beforeDelete);
      await screen.press('この共有収集日を削除する'); await settle(screen, () => screen.text().includes('共有の収集日はまだありません'));
      assert.equal((await f.read()).waste.schedules.length, 0);
      assert.ok((await loadSharedFacts(f.owner.database, groupId)).filter(fact => fact.operation.entityId === base.id).length >= 5);
    } finally { member.connection.close(); f.close(); }
  });
}
