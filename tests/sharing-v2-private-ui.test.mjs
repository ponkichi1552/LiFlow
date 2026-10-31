import { openCalendarDay } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateFixture, privateToday } from './helpers/sharing-v2-private-fixture.mjs';
import { fixture, seeds, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const repository = await import('../src/platform/storage/repository.ts');

async function setup({ common = false } = {}) {
  const personal = await privateFixture({ commonHistory: common }); const shared = await fixture(common ? { clock: () => new Date() } : undefined); const d = await shared.device(); let id = 0;
  const initial = seeds(); initial[1].payload.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  initial[1].payload.anchorDate = privateToday; initial[3].payload.configuration.anchorDate = privateToday;
  if (common) initial[2].payload.name = personal.chore.name;
  await d.repository.commit(initial);
  const controller = createV2GroupController(d.repository, { now: () => new Date(), makeId: () => `private-ui-${++id}`, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now: () => new Date(), privateTasks: personal.source,
    readPreferences: () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
  return { personal, d, controller, session, close: () => { personal.connection.close(); d.connection.close(); } };
}
async function ready(screen, text) {
  for (let n = 0; n < 25 && !screen.text().includes(text); n++) await screen.flush();
  assert.ok(screen.text().includes(text), screen.text());
}
function checkbox(screen, name, completed = false) {
  const node = screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === `${name}を${completed ? '未完了に戻す' : '完了'}`);
  assert.ok(node, `personal checkbox: ${name}, completed ${completed}`); return node;
}

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 common chores share one row and mirror completion undo and load counts while preserving original private settings`, async () => {
    const f = await setup({ common: true }); let focus;
    try {
      const definition = f.personal.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(f.personal.chore.id);
      const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        props: { purpose: 'workspace', view: 'home', loadSession: async () => f.session, onBack: () => {}, onConfiguration: () => {}, onHistory: () => {} },
        focusEffect: fn => { focus = fn; } });
      const leave = focus(); await ready(screen, f.personal.chore.name);
      assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 1);
      const before = await listSharingOutbox(f.d.database, groupId);
      await checkbox(screen, f.personal.chore.name).props.onPress(); await screen.flush();
      const mirrored = f.personal.connection.prepare('SELECT outcome FROM chore_completions').get();
      assert.ok(mirrored, screen.text()); assert.equal(mirrored.outcome, 'completed');
      let model = await f.session.readModel(); assert.equal(model.privateOverlay.home.length, 0); assert.deepEqual(model.privateOverlay.dailyLoad, {});
      assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 1);
      await screen.press('直前の完了を元に戻す'); await screen.flush();
      assert.equal(f.personal.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'incomplete');
      assert.deepEqual(f.personal.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(f.personal.chore.id), definition);
      assert.equal(JSON.stringify(await listSharingOutbox(f.d.database, groupId)).includes('非公開の手順'), false);
      leave();
    } finally { f.close(); }
  });
  test(`${platform} shared home overlays private chores and routes completion and undo to their original personal source`, async () => {
    const f = await setup(); let focus; let sharedOpened = 0;
    try {
      const before = await listSharingOutbox(f.d.database, groupId);
      const props = { purpose: 'workspace', view: 'home', loadSession: async () => f.session, onRound: () => { sharedOpened++; },
        onBack: () => {}, onConfiguration: () => {}, onHistory: () => {} };
      const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform, props, focusEffect: (fn) => { focus = fn; } });
      const leave = focus(); await ready(screen, f.personal.chore.name);
      assert.ok(screen.text().includes(`約${f.personal.chore.estimatedMinutes}分`));
      assert.match(screen.button(`${f.personal.chore.name}の説明を開く`).props.accessibilityHint, /個人の家事/u);
      await screen.press(`${f.personal.chore.name}の説明を開く`);
      assert.match(screen.text(), /非公開の手順/u); assert.equal(sharedOpened, 0);
      await checkbox(screen, f.personal.chore.name).props.onPress(); await screen.flush();
      assert.equal(checkbox(screen, f.personal.chore.name, true).props.accessibilityState.checked, true);
      assert.equal(f.personal.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'completed');
      await checkbox(screen, f.personal.chore.name, true).props.onPress(); await screen.flush();
      assert.equal(checkbox(screen, f.personal.chore.name).props.accessibilityState.checked, false);
      assert.equal(f.personal.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'incomplete');
      await checkbox(screen, f.personal.chore.name).props.onPress(); await screen.flush();
      await screen.press('直前の完了を元に戻す'); await screen.flush();
      assert.equal(f.personal.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'incomplete');
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before); leave();
    } finally { f.close(); }
  });

  test(`${platform} composite calendar counts personal recommendations and shared tasks without sending private rows to shared actions`, async () => {
    const f = await setup();
    try {
      const readOptions = { calendarMonth: privateToday }; const model = await f.session.readModel(readOptions);
      const { privateOverlay, personal, ...sharedModel } = model; const before = await listSharingOutbox(f.d.database, groupId);
      let sharedActions = 0;
      const props = { model: sharedModel, personal, privateOverlay, privateSource: f.personal.source, month: privateToday, selectedDate: privateToday, busy: false,
        actions: new Proxy({}, { get: () => () => { sharedActions++; throw new Error('private card used a shared action'); } }), onMonth: () => {}, onSelectDate: () => {}, onRound: () => {},
        run: async (work) => { await work(); const { privateOverlay, personal, ...next } = await f.session.readModel(readOptions); Object.assign(props, { model: next, personal, privateOverlay }); } };
      const screen = screenHarness('src/features/sharing/v2-ui/calendar.tsx', { exportName: 'V2Calendar', props, platform });
      await openCalendarDay(screen, privateToday);
      assert.ok(screen.nodes().some((node) => node.props.accessibilityLabel?.endsWith('、個人家事1件')));
      await checkbox(screen, f.personal.chore.name).props.onPress(); await screen.flush();
      assert.ok(screen.nodes().some((node) => node.props.accessibilityLabel?.endsWith('、個人家事0件')));
      assert.equal(checkbox(screen, f.personal.chore.name, true).props.accessibilityState.checked, true);
      assert.equal(sharedActions, 0); assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      props.privateOverlay = { status: 'unavailable', message: '個人家事を取得できませんでした。' }; screen.render();
      assert.equal(screen.text().includes(f.personal.chore.name), false); assert.match(screen.text(), /個人家事を取得できません/u);
      assert.ok(screen.nodes().some((node) => node.props.accessibilityLabel?.endsWith('、個人家事は未取得')));
    } finally { f.close(); }
  });

  test(`${platform} an old private checkbox cannot save or synchronize after changing the selected account or group`, async () => {
    for (const change of ['account', 'group']) {
      const f = await setup(); let focus; const googleDatabases = [];
      try {
        const active = { protocol: 2, groupId, userId: 'owner', identity: { deviceId: 'native' }, record: async () => ({ status: 'active' }),
          session: { controller: f.controller }, sync: async () => {} };
        const context = { ready: true, active, userId: 'owner', group: null };
        const privateData = { database: f.personal.database, snapshot: (await repository.readPersonalPlannerOverlaySnapshot(f.personal.database)).snapshot,
          refresh: async () => { privateData.snapshot = (await repository.readPersonalPlannerOverlaySnapshot(f.personal.database)).snapshot; } };
        const screen = screenHarness('src/features/sharing/v2-ui/workspace-route.tsx', { exportName: 'V2WorkspaceRoute', props: { view: 'home' }, platform, focusEffect: (fn) => { focus = fn; }, layoutEffect: (commit) => { commit(); }, mocks: {
          '../../../hooks/use-workspace': { useWorkspace: () => context }, '../../../hooks/use-planner-data': { usePlannerData: () => privateData },
          '../../../platform/sharing/private-calendar-runtime': { openPrivateCalendarRuntime: () => ({
            readPlannerPreferences: async () => null, readForPlan: async () => null, subscribe: () => () => {},
          }) },
          '@/platform/sharing/workspaces': { subscribeSharingChanges: () => () => {}, sharingFailureMessage: () => '同期を確認してください。' },
          '@/features/google-sync/coordinator': { syncGoogleTasksAfterLocalCompletion: (database) => googleDatabases.push(database) } } });
        const leave = focus(); await ready(screen, f.personal.chore.name); const old = checkbox(screen, f.personal.chore.name);
        const before = await listSharingOutbox(f.d.database, groupId);
        if (change === 'account') context.userId = 'other'; else context.active = { ...active, groupId: 'other' };
        screen.render(); await old.props.onPress(); await screen.flush();
        assert.equal(f.personal.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
        assert.equal(googleDatabases.length, 0); assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before); leave();
      } finally { f.close(); }
    }
  });
}
