import { openCalendarDay, moveCalendarMonth } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createV2DevelopmentPreview } from '../src/features/sharing/development/v2-preview-session.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const screenFile = 'src/features/sharing/development/v2-preview-screen.tsx';
async function openRoute(preview, platform, file, params, navigation, readyText) {
  let focus;
  const screen = screenHarness(`src/app/development/sharing-v2-preview/${file}.tsx`, { platform, params,
    navigate: (...args) => navigation.push(args), focusEffect: (callback) => { focus = callback; },
    transformSource: (path, source) => path.endsWith('/v2-preview-route.tsx') ? source.replaceAll('__DEV__', 'true') : source,
    mocks: { '@/platform/sharing/development-v2-preview': { developmentV2Preview: async () => preview } } });
  const leave = focus(); for (let i = 0; i < 30 && !(readyText === '共有カレンダー' ? screen.nodes().some(node => node.props.testID === 'calendar-weeks') : screen.text().includes(readyText)); i++) await screen.flush();
  assert.ok((readyText === '共有カレンダー' ? screen.nodes().some(node => node.props.testID === 'calendar-weeks') : screen.text().includes(readyText))); return { screen, leave };
}

test('v2 every isolated preview route denies release execution before opening the fixture', () => {
  let opened = 0; let focused = 0;
  for (const platform of ['ios', 'android']) for (const file of ['index', 'round', 'date', 'configuration', 'history', 'requests', 'assignment', 'assignment-requests', 'calendar', 'chores', 'details', 'add-chore', 'group-rules', 'date-rights', 'waste', 'appliances', 'appliance', 'appliance-review']) {
    const screen = screenHarness(`src/app/development/sharing-v2-preview/${file}.tsx`, { platform, params: {},
      focusEffect: () => focused++, transformSource: (path, source) => path.endsWith('/v2-preview-route.tsx') ? source.replaceAll('__DEV__', 'false') : source,
      mocks: { '@/platform/sharing/development-v2-preview': { developmentV2Preview: () => { opened++; throw new Error('Release must not open synthetic storage'); } } } });
    assert.ok(screen.text().includes('この画面は開発ビルド専用です。')); assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
  }
  assert.equal(opened, 0); assert.equal(focused, 0);
});
async function screenFixture(platform, view = 'home', clock = () => new Date('2026-10-27T01:00:00Z')) {
  const h = createDatabase(); let id = 0;
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `screen-${++id}`, now: clock,
    openDatabase: async () => ({ database: h.database, close: async () => h.connection.close() }) });
  let focus; const navigation = []; const props = { development: true, loadSession: async () => preview, view,
    onBack: () => navigation.push(['back']), onConfiguration: (choreId) => navigation.push(['configuration', choreId]), onHistory: () => navigation.push(['history']),
    onDate: (occurrenceId, subjectId) => navigation.push(['date', occurrenceId, subjectId]),
    onRound: (occurrenceId, subjectId) => navigation.push(['round', occurrenceId, subjectId]) };
  const screen = screenHarness(screenFile, { exportName: 'V2DevelopmentPreviewScreen', props, platform, focusEffect: (callback) => { focus = callback; } });
  const leave = focus();
  for (let i = 0; i < 30 && !screen.text().includes('検査用の未送信操作'); i++) await screen.flush();
  return { preview, props, screen, navigation, leave, focus: () => focus() };
}

test('v2 development fixture refuses release execution before opening storage, creating identities or accessing an account', async () => {
  let calls = 0;
  await assert.rejects(createV2DevelopmentPreview({ development: false, makeId: () => { calls++; return 'unused'; }, now: () => new Date(),
    crypto: { randomBytes: () => { calls++; throw new Error('Unexpected crypto'); } }, openDatabase: () => { calls++; throw new Error('Unexpected DB'); },
    openPrivateDatabase: () => { calls++; throw new Error('Unexpected private DB'); } }));
  assert.equal(calls, 0);
});

test('optional development personal overlays use a separate empty synthetic database without cloud or Google changes', async () => {
  const shared = createDatabase(); const personal = createDatabase(); let id = 0;
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `private-preview-${++id}`, now: () => new Date(),
    openDatabase: async () => ({ database: shared.database, close: async () => shared.connection.close() }),
    openPrivateDatabase: async (userId, groupId) => { assert.match(userId, /^qa-v2-owner-/u); assert.match(groupId, /-personal-fixture$/u);
      return { database: personal.database, close: async () => personal.connection.close() }; } });
  try {
    const model = await preview.readModel(); const row = model.privateOverlay.home[0]; assert.equal(row.chore.name, '検査用の個人家事');
    const before = shared.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all();
    await preview.privateTasks.setCompleted(row.key, row.revision, true);
    assert.equal(personal.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'completed');
    assert.deepEqual(shared.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all(), before);
    assert.equal(personal.connection.prepare('SELECT COUNT(*) AS n FROM google_sync_state').get().n, 0);
    assert.equal(shared.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
    await assert.rejects(preview.controller.sync(), /クラウドへ送信しません/u);
  } finally { await preview.close(); }
});

test('development personal-overlay seeding refuses any existing database before modifying its contents', async () => {
  const shared = createDatabase(); const personal = createDatabase(); let id = 0;
  personal.connection.exec("CREATE TABLE preserve (value TEXT); INSERT INTO preserve VALUES ('keep original')");
  try {
    await assert.rejects(createV2DevelopmentPreview({ development: true, crypto, makeId: () => `existing-preview-${++id}`, now: () => new Date(),
      openDatabase: async () => ({ database: shared.database, close: async () => shared.connection.close() }),
      openPrivateDatabase: async () => ({ database: personal.database, close: async () => {} }) }), /空の独立した保存先/u);
    assert.deepEqual(personal.connection.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table').map((row) => row.name), ['preserve']);
    assert.equal(personal.connection.prepare('SELECT value FROM preserve').get().value, 'keep original'); assert.equal(personal.writes.length, 0);
  } finally { personal.connection.close(); }
});

test('v2 development fixture uses a fresh synthetic scope and real signed SQLite operations without cloud receipts or a personal database', async () => {
  let id = 0; let opened; const h = createDatabase();
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `preview-${++id}`, now: () => new Date('2026-10-27T01:00:00Z'),
    openDatabase: async (userId, groupId) => { opened = { userId, groupId }; return { database: h.database, close: async () => h.connection.close() }; } });
  try {
    assert.ok(opened.userId.startsWith('qa-v2-owner-')); assert.ok(opened.groupId.startsWith('qa-v2-')); assert.notEqual(opened.userId, 'owner');
    let model = await preview.readModel(); assert.equal(model.plan.chores.length, 20); assert.equal(model.plan.chores.filter((chore) => chore.enabled).length, 3);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_v2_server_receipts').get().n, 0);
    const round = model.plan.occurrences.find((entry) => entry.anchorDate === model.plan.range.asOfDate && entry.configuration.policy.completion === 'one');
    const ref = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: null };
    await preview.controller.actions.claim(ref); await preview.controller.actions.complete(ref); model = await preview.readModel();
    assert.equal(model.plan.occurrences.find((entry) => entry.id === round.id).completed, true); assert.equal(model.plan.history.length, 1);
    await assert.rejects(preview.controller.sync(), /クラウドへ送信しません/);
    assert.ok(h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n > 0);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM google_sync_state').get().n, 0);
  } finally { await preview.close(); }
});

test('v2 development screen does not initialize a session or install a focus handler in a release build', async () => {
  let loaded = 0; let focused = 0;
  const screen = screenHarness(screenFile, { exportName: 'V2DevelopmentPreviewScreen', props: { development: false, loadSession: () => { loaded++; throw new Error('Unexpected'); } },
    focusEffect: () => focused++ });
  assert.ok(screen.text().includes('開発ビルド専用')); assert.equal(loaded, 0); assert.equal(focused, 0);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 isolated round navigation records explicit past work in its original group and history instead of routing the ID into a personal chore`, async () => {
    const f = await screenFixture(platform);
    try {
      await f.screen.press('フローリングを掃除するの説明を開く'); const [kind, occurrenceId, subjectId] = f.navigation.pop(); assert.equal(kind, 'round');
      Object.assign(f.props, { view: 'round', occurrenceId, subjectId }); f.screen.render();
      assert.ok(f.screen.text().includes('実施を記録'));
      const choice = f.screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '以前実施した'); choice.props.onPress(); await f.screen.flush();
      await f.screen.change('実施日', '2026-10-27'); await f.screen.change('実施時刻', '08:00'); await f.screen.press('実施を記録する');
      const model = await f.preview.readModel(); assert.equal(model.plan.history.length, 1); assert.equal(model.plan.history[0].performedAt, '2026-10-26T23:00:00.000Z');
      assert.equal(model.plan.history[0].recordedAt, '2026-10-27T01:00:00.000Z');
      f.props.view = 'history'; f.screen.render(); assert.ok(f.screen.text().includes('実施者：検査ユーザー')); assert.ok(f.screen.text().includes('登録者：検査ユーザー'));
      await f.screen.press('この完了を取り消す'); assert.equal((await f.preview.readModel()).plan.history[0].active, false);
      Object.assign(f.props, { view: 'round', subjectId: 'another-group-round' }); f.screen.render();
      assert.ok(f.screen.text().includes('対象の家事回を表示できません')); assert.equal(f.screen.nodes().some((node) => node.type === 'TextInput'), false);
    } finally { f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 preview keeps an unfinished common round visible on its personal recommended day after midnight without writing a different common anchor`, async () => {
    let instant = new Date('2026-10-27T14:59:00Z'); const f = await screenFixture(platform, 'home', () => instant);
    try {
      const before = await f.preview.readModel(); instant = new Date('2026-10-27T15:01:00Z');
      f.leave(); const leave = f.focus();
      for (let i = 0; i < 25 && !f.screen.text().includes('10月28日'); i++) await f.screen.flush();
      const after = await f.preview.readModel(); const floor = after.plan.chores.find((entry) => entry.name === 'フローリングを掃除する');
      const round = after.plan.occurrences.find((entry) => entry.choreId === floor.id && entry.anchorDate === '2026-10-27');
      assert.equal(round.subjects[0].suggestedDate, '2026-10-27');
      assert.equal(after.personal.recommendations.find((entry) => entry.occurrenceId === round.id).date, '2026-10-28');
      assert.ok(f.screen.text().includes('フローリングを掃除する')); assert.ok(f.screen.text().includes('推奨日：10月28日'));
      assert.equal(after.pendingChanges, before.pendingChanges); leave();
    } finally { f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 isolated native preview connects home, collapsed expired rounds, configuration navigation and targeted history undo to actual SQLite`, async () => {
    const f = await screenFixture(platform);
    try {
      assert.ok(f.screen.text().includes('今日の家事')); assert.ok(f.screen.text().includes('フローリングを掃除する'));
      assert.ok(f.screen.nodes().find((node) => node.type === 'FlatList').props.itemLayoutAnimation, 'shared Home must animate the virtualized cells');
      assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 2);
      await f.screen.press('期限を過ぎた家事（1件）を開く'); assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 3);
      await f.screen.press('期限を過ぎた家事（1件）を閉じる'); assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 2);
      await f.screen.press('引き受ける');
      let model = await f.preview.readModel(); const today = model.plan.range.asOfDate;
      const round = model.plan.occurrences.find((entry) => entry.anchorDate === today && entry.configuration.policy.completion === 'one');
      assert.deepEqual(round.assigneeIds, [f.preview.userId]);
      const checkbox = f.screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === 'フローリングを掃除するを完了');
      await checkbox.props.onPress(); await f.screen.flush(); model = await f.preview.readModel();
      assert.equal(model.plan.history.length, 1); assert.equal(model.plan.history[0].active, true);
      assert.equal(model.plan.occurrences.find((entry) => entry.id === round.id).completed, true);
      await f.screen.press('直前の完了を元に戻す'); model = await f.preview.readModel();
      assert.equal(model.plan.history.filter(entry => entry.active).length, 0);
      const again = f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === 'フローリングを掃除するを完了');
      await again.props.onPress(); await f.screen.flush(); model = await f.preview.readModel();
      assert.equal(model.plan.history.filter(entry => entry.active).length, 1);
      await f.screen.press('「フローリングを掃除する」の設定'); assert.deepEqual(f.navigation.pop(), ['configuration', round.choreId]);
      await f.screen.press('実施履歴'); assert.deepEqual(f.navigation.pop(), ['history']);
      f.props.view = 'history'; f.screen.render(); assert.ok(f.screen.text().includes('実施済み')); await f.screen.press('この完了を取り消す');
      model = await f.preview.readModel(); assert.equal(model.plan.history[0].active, false); assert.ok(f.screen.text().includes('取消済み'));
      assert.equal(model.plan.occurrences.find((entry) => entry.id === round.id).completed, false);
    } finally { f.leave(); await f.preview.close(); }
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 calendar routes register an actual past round beyond the home cutoff and preserve its performed and recorded dates`, async () => {
    const f = await screenFixture(platform); let cleanup;
    try {
      const [chore] = await f.preview.controller.actions.addChore('過去の家事');
      await f.preview.controller.actions.configureChore(chore.entityId, { policy: { completion: 'one', assignment: { mode: 'open', memberIds: [] } },
        anchorDate: '2026-10-12', intervalDays: 30, windowBeforeDays: 2, windowAfterDays: 2, effectiveFrom: '2026-10-12', active: true });
      assert.equal((await f.preview.readModel()).plan.occurrences.some((round) => round.choreId === chore.entityId), false);
      const navigation = []; let { screen, leave } = await openRoute(f.preview, platform, 'calendar', {}, navigation, '共有カレンダー'); cleanup = leave;
      const day = screen.nodes().find((node) => node.props.accessibilityLabel === '2026年10月12日、確認できる未完了の共有家事1件'); assert.ok(day);
      await openCalendarDay(screen, '2026-10-12');
      await screen.press('過去の家事の説明を開く'); const target = navigation.at(-1); assert.equal(target[1].params.anchorDate, '2026-10-12');
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'round', target[1].params, navigation, '実施を記録')); cleanup = leave;
      const past = screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '以前実施した');
      past.props.onPress(); await screen.flush(); await screen.change('実施日', '2026-10-12'); await screen.change('実施時刻', '12:30');
      await screen.press('実施を記録する'); assert.ok(screen.text().includes('実施記録を端末に保存しました'));
      const history = (await f.preview.readModel()).plan.history.find((record) => record.choreId === chore.entityId);
      assert.equal(history.performedAt, '2026-10-12T03:30:00.000Z'); assert.equal(history.recordedAt, '2026-10-27T01:00:00.000Z');
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'calendar', {}, navigation, '共有カレンダー')); cleanup = leave;
      assert.ok(screen.nodes().some((node) => node.props.accessibilityLabel === '2026年10月12日、確認できる未完了の共有家事0件'));
    } finally { cleanup?.(); f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 a failed read-only month change does not claim that data was saved or the unloaded day was empty`, async () => {
    const f = await screenFixture(platform); let cleanup; let failed = false;
    try {
      const preview = { ...f.preview, readModel: async (options) => {
        if (options?.calendarMonth && options.calendarMonth !== 'current' && !failed) { failed = true; throw new Error('Read unavailable'); }
        return f.preview.readModel(options);
      } };
      const before = (await f.preview.readModel()).pendingChanges;
      const { screen, leave } = await openRoute(preview, platform, 'calendar', {}, [], '共有カレンダー'); cleanup = leave;
      await moveCalendarMonth(screen, 1); for (let i = 0; i < 35 && !failed; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await screen.flush(); } assert.ok(screen.text().includes('表示を更新できませんでした'));
      assert.equal(screen.text().includes('端末に保存済みです'), false); assert.equal(screen.text().includes('この日の共有家事はありません'), false);
      assert.equal((await f.preview.readModel()).pendingChanges, before);
      await screen.press('この月を再読込'); assert.ok(screen.text().includes('2026年11月'));
      assert.equal(screen.text().includes('この月の共有予定を取得できていません'), false);
    } finally { cleanup?.(); f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 assignment routes preserve the group round identity through explicit save and request-list navigation`, async () => {
    const f = await screenFixture(platform); let cleanup;
    try {
      const model = await f.preview.readModel(); const round = model.plan.occurrences.find((r) => r.anchorDate === model.plan.range.asOfDate && r.configuration.policy.completion === 'one');
      const subject = round.subjects[0]; const navigation = [];
      let { screen, leave } = await openRoute(f.preview, platform, 'round', { occurrenceId: round.id, subjectId: subject.id }, navigation, '実施を記録'); cleanup = leave;
      await screen.press('担当を変更'); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/development/sharing-v2-preview/assignment', params: { occurrenceId: round.id, subjectId: subject.id } }]);
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'assignment', { occurrenceId: round.id, subjectId: subject.id }, navigation, '担当変更を保存')); cleanup = leave;
      const before = await f.preview.readModel(); const control = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：検査ユーザー');
      assert.ok(control); control.props.onValueChange(true); await screen.flush(); assert.equal((await f.preview.readModel()).pendingChanges, before.pendingChanges);
      await screen.press('担当変更を保存'); assert.ok(screen.text().includes('担当変更を端末に保存しました'));
      assert.deepEqual((await f.preview.readModel()).plan.occurrences.find((entry) => entry.id === round.id).assigneeIds, [model.viewerUserId]);
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'index', {}, navigation, '今日の家事')); cleanup = leave;
      await screen.press('担当の変更申請'); assert.deepEqual(navigation.at(-1), ['push', '/development/sharing-v2-preview/assignment-requests']);
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'assignment-requests', {}, navigation, '担当の変更申請はありません')); cleanup = leave;
      assert.equal((await f.preview.readModel()).assignmentRequests.length, 0);
    } finally { cleanup?.(); f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 request route stays in the isolated group and shows a truthful empty state without creating a request`, async () => {
    const f = await screenFixture(platform); let cleanup;
    try {
      const params = {}; const navigation = [];
      let { screen, leave } = await openRoute(f.preview, platform, 'index', params, navigation, '今日の家事'); cleanup = leave;
      const before = await f.preview.readModel(); await screen.press('日時の変更申請');
      assert.deepEqual(navigation[0], ['push', '/development/sharing-v2-preview/requests']);
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'requests', {}, navigation, '日時の変更申請はありません')); cleanup = leave;
      assert.ok(screen.text().includes('日時の変更申請')); assert.ok(screen.text().includes('日時の変更申請はありません'));
      assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
      assert.equal((await f.preview.readModel()).pendingChanges, before.pendingChanges);
    } finally { cleanup?.(); f.leave(); await f.preview.close(); }
  });
}

test('v2 preview discards a late read after navigation and a successful retry clears its previous loading error', async () => {
  const f = await screenFixture('ios');
  try {
    let resolve; let focus; let attempts = 0;
    const props = { ...f.props, loadSession: async () => { if (++attempts === 1) throw new Error('Temporary read failure'); return f.preview; } };
    const screen = screenHarness(screenFile, { exportName: 'V2DevelopmentPreviewScreen', props, focusEffect: (callback) => { focus = callback; } });
    const leave = focus(); for (let i = 0; i < 15 && !screen.text().includes('Temporary read failure'); i++) await screen.flush();
    assert.ok(screen.text().includes('Temporary read failure')); await screen.press('読み込みを再試行'); assert.ok(!screen.text().includes('Temporary read failure'));
    props.loadSession = () => new Promise((ready) => { resolve = ready; }); screen.render(); const leaveNext = focus(); leaveNext();
    resolve(f.preview); await screen.flush(); assert.ok(!screen.text().includes('Temporary read failure')); leave();
  } finally { f.leave(); await f.preview.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 date route carries the actual group occurrence and subject into a signed form without opening a private chore`, async () => {
    const f = await screenFixture(platform); let cleanup;
    try {
      const model = await f.preview.readModel(); const round = model.plan.occurrences.find((r) => r.anchorDate === model.plan.range.asOfDate && r.configuration.policy.completion === 'one');
      const params = { occurrenceId: round.id, subjectId: round.subjects[0].id }; const navigation = [];
      let { screen, leave } = await openRoute(f.preview, platform, 'round', params, navigation, '日時を変更'); cleanup = leave;
      await screen.press('日時を変更'); assert.equal(navigation[0][0], 'push');
      assert.equal(navigation[0][1].pathname, '/development/sharing-v2-preview/date'); assert.deepEqual(navigation[0][1].params, { occurrenceId: round.id, subjectId: round.subjects[0].id });
      cleanup(); ({ screen, leave } = await openRoute(f.preview, platform, 'date', params, navigation, '日時の指定・変更')); cleanup = leave;
      await screen.change('実施日', '2026-10-28'); await screen.press('日時を指定・申請する');
      for (let i = 0; i < 30 && !screen.text().includes('日時指定を端末に保存'); i++) await screen.flush();
      assert.ok(screen.text().includes('日時指定を端末に保存')); const next = await f.preview.readModel();
      assert.deepEqual(next.plan.occurrences.find((r) => r.id === round.id).subjects[0].formalDate.target, { precision: 'date', date: '2026-10-28' });
      params.subjectId = 'unrelated-private-id'; screen.render(); assert.ok(screen.text().includes('対象の家事回を表示できません')); assert.equal(screen.nodes().some((n) => n.type === 'TextInput'), false);
    } finally { cleanup?.(); f.leave(); await f.preview.close(); }
  });
}
