import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { buildHomeRows } from '../src/features/sharing/v2-ui/home-rows.ts';
import { homeReviewData, homeReviewScenarios, homeReviewViewer } from '../src/features/development/ui-review/home-review-data.ts';

function home(scenario, scope = 'current', expanded = false, order = 'heavy') {
  const fixture = homeReviewData(scenario);
  return { ...fixture, rows: buildHomeRows(fixture.model, fixture.personal, fixture.overlay, scope, order, new Map(), expanded) };
}

test('home review data exercises distinct source, period, completion and empty states using the production home projection', () => {
  const ids = homeReviewScenarios.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    for (const scope of ['current', 'next']) {
      const { rows, scenario } = home(id, scope, true);
      assert.equal(scenario, id);
      assert.equal(new Set(rows.listRows.map(row => row.key)).size, rows.listRows.length, id);
    }
  }
  const mixed = home('mixed');
  const today = mixed.rows.listRows.filter(row => row.kind === 'today').map(row => row.item);
  assert.equal(mixed.rows.total, 4);
  assert.equal(mixed.rows.done, 1);
  assert.equal(today.filter(row => row.source === 'waste').length, 1);
  assert.ok(today.some(row => row.source === 'personal' && row.row.chore.name === '洗面台の清掃'));
  assert.ok(today.some(row => row.source === 'shared' && mixed.model.plan.chores.find(chore => chore.id === row.round.choreId)?.name === '洗面台の清掃'));
  assert.equal(home('overdue').rows.expiredCount, 2);
  assert.deepEqual(home('overdue', 'current', true).rows.listRows.filter(row => row.kind === 'expired').map(row => row.item.source).sort(), ['personal', 'shared']);
  const expiredOnly = home('expired-only').rows;
  assert.equal(expiredOnly.total, 0);
  assert.equal(expiredOnly.expiredCount, 2);
  assert.equal(expiredOnly.onlyExpired, true);
  assert.equal(expiredOnly.listRows.filter(row => row.kind === 'expired').length, 2);
  assert.ok(!expiredOnly.listRows.some(row => row.kind === 'emptyToday'));
  const expiredSources = order => home('expired-only', 'current', true, order).rows.listRows.filter(row => row.kind === 'expired').map(row => row.item.source);
  assert.deepEqual(expiredSources('heavy'), ['shared', 'personal']);
  assert.deepEqual(expiredSources('light'), ['personal', 'shared']);
  const upcoming = home('upcoming');
  assert.equal(upcoming.rows.total, 0);
  const dates = view => view.rows.listRows.filter(row => row.kind === 'upcomingDate').map(row => row.date);
  assert.deepEqual(dates(upcoming), ['2026-12-31', '2027-01-01', '2027-01-03']);
  assert.deepEqual(dates(home('upcoming', 'next')), ['2027-01-04', '2027-01-06', '2027-01-09']);
  assert.equal(home('completed').rows.summary.percent, 100);
  assert.equal(home('empty').rows.summary.showProgress, false);
  assert.equal(home('empty-shared').overlay.setupCompleted, false);
  assert.equal(home('private-unavailable').overlay.status, 'unavailable');
  assert.notEqual(home('time-zones').overlay.today, home('time-zones').model.plan.range.asOfDate);
  const long = home('overflow');
  assert.ok(long.rows.total >= 30);
  const [sharedName, personalName] = long.rows.listRows;
  const shared = long.model.plan.chores.find(chore => chore.id === sharedName.item.round.choreId);
  assert.match(shared.name, /共用ワークスペース/);
  assert.equal(shared.estimatedMinutes, 125);
  assert.match(personalName.item.row.chore.name, /HiyoriSampleAirCareLivingRoomEdition/);
  assert.equal(personalName.item.row.chore.estimatedMinutes, undefined);
});

function device(platform, scenario) {
  const external = () => assert.fail('the home review used a device preference, account, external destination or real birthday data');
  return screenHarness('src/features/development/ui-review/home-review.tsx', {
    exportName: 'HomeReview', props: { scenario }, platform, navigate: external, flatListItemHeight: 55,
    mocks: { 'expo-sqlite/kv-store': { __esModule: true, default: { getItemSync: external, setItemSync: external } },
      '@/features/calendar/use-local-calendar': { useOwnBirthday: external } },
  });
}
const checkbox = (screen, label) => {
  const found = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === label);
  assert.ok(found, label);
  return found;
};
function sourceIcons(nodes) {
  return nodes.flatMap(node => typeof node === 'string' ? [] : [
    ...(node.props.testID?.startsWith('chore-source-') ? [node.props.testID] : []),
    ...sourceIcons(node.children ?? []),
  ]);
}
for (const platform of ['ios', 'android']) {
  test(`${platform} fixture claims, completion, overdue undo and weekly switches stay within one home review session`, async t => {
    const screen = device(platform, 'mixed');
    t.after(() => screen.unmount());
    assert.match(screen.text(), /4件中1件/);
    checkbox(screen, '洗面台の清掃（個人）を完了');
    checkbox(screen, '洗面台の清掃（共有）を完了');
    assert.deepEqual([...new Set(sourceIcons(screen.render()))].sort(), ['chore-source-personal', 'chore-source-shared']);
    assert.doesNotMatch(screen.text(), /個人 ·|共有 ·|あおい/u);
    await screen.press('担う');
    assert.ok(!screen.nodes().some(node => node.props.accessibilityLabel === '担う'));
    await screen.press('期限を過ぎた家事（1件）を開く');
    checkbox(screen, '玄関の床掃除を完了').props.onPress();
    await screen.flush();
    assert.match(screen.text(), /5件中2件/);
    await screen.press('直前の完了を元に戻す');
    assert.match(screen.text(), /4件中1件/);
    assert.equal(checkbox(screen, '玄関の床掃除を完了').props.disabled, false);
    await screen.press('期限を過ぎた家事（1件）を閉じる');
    await screen.press('来週');
    assert.match(screen.text(), /1月5日（火）のおすすめ/);
    await screen.press('負荷の並び順：重い順');
    screen.button('負荷の並び順：軽い順');
    await screen.press('浴室の清掃の説明を開く');
    assert.match(screen.text(), /家事の手順/);
    await screen.press('前の画面に戻る');
    await screen.press('設定を開く');
    await screen.press('負荷の並び順：軽い順');
    await screen.press('前の画面に戻る');
    screen.button('負荷の並び順：重い順');
    const fresh = device(platform, 'mixed');
    t.after(() => fresh.unmount());
    fresh.button('担う');
    assert.match(fresh.text(), /4件中1件/);
  });
}

test('the home review identifies a single overdue date and keeps the month when recommendations cross it', async t => {
  const expired = device('ios', 'expired-only');
  const shared = device('ios', 'overdue');
  const upcoming = device('ios', 'upcoming');
  t.after(() => { expired.unmount(); shared.unmount(); upcoming.unmount(); });
  assert.match(expired.text(), /2026\/12\/30・水.*期限を過ぎた家事/u);
  assert.doesNotMatch(expired.text(), /今日の家事/u);
  assert.ok(!expired.nodes().some(node => node.props.accessibilityLabel === '期限を過ぎた家事（2件）を開く'));
  assert.match(expired.text(), /期限 12月24日/u);
  await shared.press('期限を過ぎた家事（2件）を開く');
  assert.match(shared.text(), /期限 12月27日/u);
  assert.match(upcoming.text(), /31日（木）のおすすめ/u);
  assert.match(upcoming.text(), /1月1日（金）のおすすめ/u);
  await upcoming.press('来週');
  assert.match(upcoming.text(), /1月4日（月）のおすすめ/u);
});

test('home keeps the chore list visible when weather reschedules laundry or cannot be read', t => {
  const adjusted = device('ios', 'weather');
  const unavailable = device('ios', 'weather-unavailable');
  t.after(() => { adjusted.unmount(); unavailable.unmount(); });
  for (const screen of [adjusted, unavailable]) {
    assert.match(screen.text(), /今日の家事.*調理後の片付け/u);
    assert.doesNotMatch(screen.text(), /予報を取得できませんでした|合わせて洗濯予定を調整しました|Weather data/u);
  }
  assert.match(adjusted.text(), /31日（木）のおすすめ.*衣類・タオルの洗濯/u);
  checkbox(unavailable, '衣類・タオルの洗濯を完了');
});

test('shared home review can complete personal setup and returns to the same shared home', async t => {
  const screen = device('ios', 'empty-shared');
  t.after(() => screen.unmount());
  assert.match(screen.text(), /今日の共有家事はありません/u);
  await screen.press('個人の家事を設定');
  screen.button('次へ');
  await screen.press('ホームに戻る');
  screen.button('個人の家事を設定');
  await screen.press('個人の家事を設定');
  await screen.press('次へ');
  await screen.press('設定して始める');
  assert.match(screen.text(), /ひより荘（サンプル）/u);
  assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '個人の家事を設定'), false);
});

test('home review shows weekly assignments and only the dates that differ from the home date', async t => {
  const assigned = device('ios', 'assignments');
  const zones = device('ios', 'time-zones');
  t.after(() => { assigned.unmount(); zones.unmount(); });
  assert.match(assigned.text(), /15:15〜16:45/u);
  assert.doesNotMatch(assigned.text(), /12月30日 15:15|12月30日 16:45|約5分 · 12月30日|Europe\/London|指定時の地域/u);
  assert.match(assigned.text(), /31日（木）のおすすめ/u);
  await assigned.press('来週');
  assert.match(assigned.text(), /1月4日（月）のおすすめ/u);
  assert.match(zones.text(), /約20分 · 12月29日/u);
  assert.doesNotMatch(zones.text(), /America\/Los_Angeles|Europe\/London|個人の今日|地域が異なる/u);
});

test('shared review rows keep actionable conditions and independent per-member subjects', async t => {
  const fixture = home('conditions');
  const screen = device('ios', 'conditions');
  t.after(() => screen.unmount());
  assert.doesNotMatch(screen.text(), /再実施の目安|先に必要な家事/u);
  assert.doesNotMatch(screen.text(), /実施記録の確認・承認待ち|引き受けが重なっています|担当が競合しています|以前の担当指定|日時の確認が必要/u);
  assert.deepEqual(sourceIcons(screen.render()), []);
  assert.equal(checkbox(screen, 'ごみ箱の清掃を完了').props.disabled, true);
  const checked = recipe => screen.nodes().find(node => node.type === 'FlatList').props.data
    .find(row => row.item?.source === 'shared' && row.item.round.choreId.endsWith(recipe))?.item.subject.completed;
  assert.equal(checkbox(screen, '槽乾燥の操作を完了').props.disabled, false);
  checkbox(screen, '槽乾燥の操作を完了').props.onPress();
  await screen.flush();
  assert.equal(checked('.035'), true);
  assert.equal(checked('.034'), false);
  checkbox(screen, '洗濯槽のお手入れを完了').props.onPress();
  await screen.flush();
  assert.equal(checked('.034'), true);
  assert.ok(fixture.model.plan.occurrences.some(round => round.subjects.some(subject => subject.completed && subject.strictInstructionUnfulfilled)));
  const assigned = home('assignments');
  const each = assigned.model.plan.occurrences.find(round => round.configuration.policy.completion === 'perMember');
  assert.equal(each.subjects.length, assigned.model.plan.members.length);
  assert.ok(assigned.rows.listRows.filter(row => row.kind === 'today' && row.item.source === 'shared')
    .every(row => row.item.subject.subjectUserId === null || row.item.subject.subjectUserId === homeReviewViewer));
  const done = device('android', 'completed');
  t.after(() => done.unmount());
  assert.equal(checkbox(done, '窓まわりの清掃を未完了に戻す').props.disabled, true);
});

test('reading a chore guide retains the position in a long review list', async t => {
  const screen = device('ios', 'overflow');
  t.after(() => screen.unmount());
  const list = screen.nodes().find(node => node.type === 'FlatList');
  list.props.onScroll({ nativeEvent: { contentOffset: { y: 55 * 18 } } });
  screen.render();
  const opener = screen.nodes().find(node => node.props.accessibilityLabel?.endsWith('の説明を開く')).props.accessibilityLabel;
  await screen.press(opener);
  await screen.press('前の画面に戻る');
  screen.button(opener);
  assert.ok(!screen.nodes().some(node => node.props.accessibilityLabel?.startsWith('共用ワークスペース')));
});
