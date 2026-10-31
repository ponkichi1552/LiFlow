import {  } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createV2DevelopmentPreview } from '../src/features/sharing/development/v2-preview-session.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { createWorkspaceDisplayStore } from '../src/features/sharing/v2-ui/workspace-display-store.ts';

// RN provides an idle scheduler. Advance it deliberately so prefetch is distinct
// from lifecycle/command work instead of racing a Node-only setTimeout fallback.
const idleWork = new Map(); let idleId = 0;
globalThis.requestIdleCallback = work => { const id = ++idleId; idleWork.set(id, () => { idleWork.delete(id); work({ didTimeout: false, timeRemaining: () => 50 }); }); return id; };
globalThis.cancelIdleCallback = id => idleWork.delete(id);

async function fixture() {
  const h = createDatabase(); let id = 0; let syncs = 0; let clock = () => new Date();
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `workspace-screen-${++id}`, now: () => clock(),
    openDatabase: async () => ({ database: h.database, close: async () => h.connection.close() }) });
  const name = (await preview.readModel({ management: true, groupPolicy: true })).groupSettings.name;
  await preview.controller.actions.editGroupOptions([{ field: 'name', value: '選択した家族', basisOperationIds: name.candidates.map(candidate => candidate.operationId) }]);
  const active = { protocol: 2, groupId: preview.groupId, userId: preview.userId, identity: { deviceId: 'native-device' }, record: async () => ({ status: 'active' }),
    session: { controller: preview.controller }, sync: async () => { syncs++; } };
  const context = { ready: true, active, userId: preview.userId, group: { groupId: preview.groupId, displayName: '選択した家族' } };
  const leaves = new Set();
  return { ...h, leaves, dispose: () => { for (const leave of leaves) leave(); h.connection.close(); }, preview, context, personalSnapshot: { settings: { frequencyMode: 'balanced', restDays: [], heavyDailyLimit: 2, normalDailyLimit: 3 } }, callbacks: new Set(), calendarCallbacks: new Set(), localCalendarCallbacks: new Set(), appStateListeners: new Set(),
    now: () => clock(), setNow: value => { clock = () => new Date(value); }, calendarReads: 0, calendarChecks: [], sessionInputs: [], synced: () => syncs };
}
async function route(f, platform, file, params = {}, readyText = '今日の家事') {
  let focus; const navigation = [];
  const view = ({ index: 'home', 'add-chore': 'addChore', 'assignment-requests': 'assignmentRequests', 'date-rights': 'dateRights', 'group-rules': 'groupPolicy', 'appliance-review': 'applianceReview' })[file] ?? file;
  const screen = screenHarness('tests/helpers/workspace-route-host.tsx', { effectDependencies: true, effect: callback => callback(), exportName: 'WorkspaceRouteHost', layoutEffect: callback => callback(), props: { view }, platform, params, focusEffect: (callback) => { focus = callback; },
    appStateListener: callback => f.appStateListeners.add(callback), navigate: (...args) => navigation.push(args),
    mocks: {
      // The native document is tested separately with actual virtual unmounts. Route tests
      // exercise the requested chapter, as the native jump makes it the visible editor.
      '../../../components/chore-book': { ChoreBook: props => ({ type: 'ChoreBook', props: { ...props, children: [props.title, props.titleAccessory, props.header,
        props.renderChore(props.chores.find(row => row.id === props.selectedId) ?? props.chores[0])] } }) },
      '../../../hooks/use-workspace': { useWorkspace: () => f.context },
      './workspace-display-store': { createWorkspaceDisplayStore: loader => createWorkspaceDisplayStore(loader, f.now) },
      './screen-session': { createV2ScreenSession: input => { f.sessionInputs.push(input); const source = createV2ScreenSession({ ...input, now: f.now });
        return { ...source, readModel: async options => { (f.planReadOptions ??= []).push(options); return source.readModel(options); } }; } },
      '@/platform/sharing/workspaces': { sharingFailureMessage: () => '同期を確認してください。', subscribeSharingChanges: (callback) => { f.callbacks?.add(callback); return () => f.callbacks?.delete(callback); } },
      '../../../platform/sharing/private-calendar-runtime': { openPrivateCalendarRuntime: userId => { assert.equal(userId, f.context.userId); return {
        subscribe: callback => { f.calendarCallbacks.add(callback); return () => f.calendarCallbacks.delete(callback); },
        readForPlan: async () => { f.calendarReads++; return f.calendar ?? null; },
        readPlannerPreferences: async () => f.preferences ?? null,
        readOwnCalendar: async target => { f.calendarChecks.push(structuredClone(target)); return { kind: 'conflict' }; },
      }; } },
      '../../../platform/storage/calendar-events': {
        readLocalCalendar: async () => ({ events: f.localEvents ?? [], exceptions: [], categories: [], draft: null }),
        subscribeLocalCalendar: (_database, changed) => { f.localCalendarCallbacks.add(changed); return () => f.localCalendarCallbacks.delete(changed); },
      },
      '../../../hooks/use-planner-data': { usePlannerData: () => ({ database: f.database, snapshot: f.personalSnapshot }) } } });
  const leaveFocus = focus?.(); const leave = () => { leaveFocus?.(); screen.unmount(); f.leaves.delete(leave); }; f.leaves.add(leave); for (let n = 0; n < 30 && !(readyText === '共有カレンダー' ? screen.nodes().some(node => node.props.testID === 'calendar-weeks') : screen.text().includes(readyText)); n++) await screen.flush();
  assert.ok((readyText === '共有カレンダー' ? screen.nodes().some(node => node.props.testID === 'calendar-weeks') : screen.text().includes(readyText)), screen.text()); return { screen, leave, navigation };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} wider calendar and settings preparation waits for idle and a superseded preparation cannot restart it`, async () => {
    const f = await fixture();
    const waitForIdle = async () => { for (let i = 0; i < 75 && idleWork.size === 0; i++) { await new Promise(resolve => setTimeout(resolve, 20)); await ui.screen.flush(); }
      assert.ok(idleWork.size); return [...idleWork.values()].at(-1); };
    let ui;
    try {
      ui = await route(f, platform, 'index'); const oldWarm = await waitForIdle();
      assert.equal(f.planReadOptions.some(options => options?.calendarMonth), false);
      for (const callback of f.appStateListeners) callback('active');
      oldWarm(); assert.equal(f.planReadOptions.some(options => options?.calendarMonth), false, 'cancelled idle callbacks cannot start stale preparation');
      const warm = await waitForIdle(); warm();
      for (let i = 0; i < 100 && !f.planReadOptions.some(options => options?.choreSettings); i++) await ui.screen.flush();
      assert.ok(f.planReadOptions.some(options => options?.calendarMonth === 'current'));
      assert.ok(f.planReadOptions.some(options => options?.choreSettings && options.management));
      ui.leave();
    } finally { f.dispose(); }
  });
  test(`${platform} a saved home is usable before restore while completion waits for current authority and commits once after restoration`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const active = f.context.active;
      f.context.startupDisplay = { record: { ...f.context.group, userId: f.context.userId }, model }; f.context.active = null;
      const before = (await listSharingOutbox(f.database, f.preview.groupId)).length;
      const ui = await route(f, platform, 'index');
      assert.equal(f.sessionInputs.length, 0, 'saved display does not construct an unverified controller');
      const check = ui.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && typeof node.props.onPress === 'function' && !node.props.disabled);
      assert.ok(check, ui.screen.text()); const completing = check.props.onPress();
      await ui.screen.flush(); assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before);
      f.context.active = active; ui.screen.render(); await ui.screen.flush(); await completing; await ui.screen.flush();
      assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before + 1);
      ui.leave();
    } finally { f.dispose(); }
  });
  test(`${platform} normal v2 routes use only the authenticated private preference limits and preserve shared outbox and plan`, async () => {
    const f = await fixture();
    try {
      const before = await f.preview.readModel(); const outbox = await listSharingOutbox(f.database, f.context.active.groupId);
      f.preferences = { ownerUserId: f.context.userId, restDays: [1], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 7 } };
      const ui = await route(f, platform, 'index', {}, '今日の家事');
      const own = await f.sessionInputs.at(-1).readPreferences(); assert.deepEqual(own.settings.restDays, [1]); assert.deepEqual(own.settings.loadLimits, f.preferences.loadLimits);
      assert.equal((await f.preview.readModel()).plan.planHash, before.plan.planHash); assert.deepEqual(await listSharingOutbox(f.database, f.context.active.groupId), outbox); ui.leave?.();
      f.preferences = { ...f.preferences, ownerUserId: 'foreign-owner' };
      const denied = await route(f, platform, 'index', {}, '本人の予定設定を確認してください。');
      assert.equal(denied.screen.text().includes('フローリングを掃除する'), false); assert.deepEqual(await listSharingOutbox(f.database, f.context.active.groupId), outbox); denied.leave?.();
    } finally { f.dispose(); }
  });
  test(`${platform} selected v2 workspace routes reuse authenticated forms and preserve historical round parameters`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const round = model.plan.occurrences.find((item) => item.activeInPeriod); const subject = round.subjects[0];
      const params = { occurrenceId: round.id, subjectId: subject.id, anchorDate: round.anchorDate };
      for (const [file, ready] of [['calendar', '共有カレンダー'], ['history', '実施履歴'], ['requests', '日時の変更申請'], ['assignment-requests', '担当の変更申請'],
        ['round', '共通の設定を開く'], ['date', '日時の指定'], ['assignment', '担当変更の適用範囲'], ['chores', '家事一覧'],
        ['add-chore', 'この内容を共有家事に追加'], ['details', '共有家事の名前'], ['group-rules', 'グループの種類'], ['date-rights', '日時変更の権限'], ['waste', '登録した収集日'], ['appliances', '登録した家電'], ['appliance', '共有家電のお手入れ'], ['appliance-review', '選択したPDFを解析する']]) {
        const r = await route(f, platform, file, ['details', 'date-rights'].includes(file) ? { choreId: round.choreId } : params, ready);
        try {
          assert.equal(f.sessionInputs.at(-1).groupId, f.context.active.groupId, 'routes retain the authenticated group without repeating its name on every page');
          assert.equal(r.screen.text().includes('クラウドへ送信しません'), false);
        } finally { r.leave?.(); }
      }
      const home = await route(f, platform, 'index');
      assert.equal(home.screen.text().includes('今すぐ同期'), false);
      assert.equal(home.screen.text().includes('設定を検査'), false);
      await home.screen.press('グループを開く'); assert.deepEqual(home.navigation.at(-1), ['push', { pathname: '/sharing/group/[groupId]', params: { groupId: f.preview.groupId } }]); home.leave?.();
      const detail = await route(f, platform, 'round', params, '共通の設定を開く'); await detail.screen.press('日時を変更');
      assert.deepEqual(detail.navigation.at(-1), ['push', { pathname: '/group-v2/date', params }]); detail.leave?.();
      const editor = await route(f, platform, 'details', { choreId: round.choreId }, '共有家事の名前'); await editor.screen.press('日時変更の権限を開く');
      assert.ok(editor.screen.text().includes('この家事だけに適用')); assert.equal(editor.navigation.length, 0); editor.leave?.();
    } finally { f.dispose(); }
  });
  test(`${platform} unselected or mismatched v2 workspace routes never load shared controllers or expose edit controls`, () => {
    for (const active of [null, { protocol: 1 }, { protocol: 2, userId: 'another-account' }]) {
      let focused = 0;
      const context = { ready: true, active, userId: 'owner' };
      for (const file of ['index', 'round', 'date', 'assignment', 'configuration', 'requests', 'assignment-requests', 'history', 'calendar', 'chores', 'details', 'add-chore', 'group-rules', 'date-rights', 'waste', 'appliances', 'appliance', 'appliance-review']) {
        const view = ({ index: 'home', 'add-chore': 'addChore', 'assignment-requests': 'assignmentRequests', 'date-rights': 'dateRights', 'group-rules': 'groupPolicy', 'appliance-review': 'applianceReview' })[file] ?? file;
        const screen = screenHarness('tests/helpers/workspace-route-host.tsx', { exportName: 'WorkspaceRouteHost', layoutEffect: callback => callback(), props: { view }, platform, params: {}, focusEffect: () => { focused++; }, mocks: {
          '../../../hooks/use-workspace': { useWorkspace: () => context }, '../../../hooks/use-planner-data': { usePlannerData: () => ({}) } } });
        assert.match(screen.text(), /所属グループを確認/u); assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
      }
      assert.equal(focused, 0);
    }
  });
  test(`${platform} an unconfigured shared chore stays disabled until explicit valid initial settings and then enters the autosave editor`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const chore = model.plan.chores.find((item) => item.name === 'トイレを掃除する');
      const r = await route(f, platform, 'configuration', { choreId: chore.id }, '家事の種類と周期を設定'); const before = (await listSharingOutbox(f.database, f.preview.groupId)).length;
      await r.screen.press('この条件で家事を有効にする'); assert.match(r.screen.text(), /種類を選んで/u);
      assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before);
      const preset = r.screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === 'メンバーごとに行う');
      assert.ok(preset); preset.props.onPress(); await r.screen.flush();
      await r.screen.change('初回の周期', '0'); await r.screen.press('この条件で家事を有効にする');
      assert.match(r.screen.text(), /周期は1/u); assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before);
      await r.screen.change('初回の周期', '7'); await r.screen.press('この条件で家事を有効にする');
      assert.match(r.screen.text(), /変更は自動で保存/u);
      const configured = (await f.preview.readModel()).configurations.find((item) => item.choreId === chore.id).configuration;
      assert.equal(configured.active, true); assert.equal(configured.intervalDays, 7); assert.equal(configured.policy.completion, 'perMember');
      assert.deepEqual(configured.targetMemberIds, [f.preview.userId]); assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before + 2); r.leave?.();
    } finally { f.dispose(); }
  });
  test(`${platform} an initial shared chore can start on a future anchor without invalidating its effective date or creating past work`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const chore = model.plan.chores.find((item) => item.name === 'トイレを掃除する'); const future = addDays(model.plan.range.asOfDate, 7);
      const r = await route(f, platform, 'configuration', { choreId: chore.id }, '家事の種類と周期を設定');
      const preset = r.screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '誰か1人が行う');
      preset.props.onPress(); await r.screen.flush(); await r.screen.change('共有家事の基準日', future); await r.screen.change('初回の周期', '7');
      await r.screen.press('この条件で家事を有効にする'); const next = await f.preview.readModel();
      const configuration = next.configurations.find((item) => item.choreId === chore.id).configuration;
      assert.ok(configuration, r.screen.text()); assert.equal(configuration.anchorDate, future); assert.equal(configuration.effectiveFrom, future);
      assert.ok(next.plan.occurrences.filter((round) => round.choreId === chore.id).every((round) => round.anchorDate >= future));
      assert.equal(next.plan.history.some((record) => record.choreId === chore.id), false); r.leave?.();
    } finally { f.dispose(); }
  });

  test(`${platform} normal shared creation replaces the add screen and opens its new disabled chore in the same workspace`, async () => {
    const f = await fixture();
    try {
      const r = await route(f, platform, 'add-chore', {}, 'この内容を共有家事に追加');
      await r.screen.change('追加する共有家事の名前', '通常導線で追加した家事'); await r.screen.press('この内容を共有家事に追加');
      for (let n = 0; n < 25 && !r.navigation.length; n++) await r.screen.flush();
      const chore = (await f.preview.readModel()).plan.chores.find((item) => item.name === '通常導線で追加した家事'); assert.ok(chore); assert.equal(chore.enabled, false);
      assert.deepEqual(r.navigation.at(-1), ['replace', { pathname: '/group-v2/details', params: { choreId: chore.id } }]); r.leave?.();
    } finally { f.dispose(); }
  });
  test(`${platform} foreground shared changes refresh only the selected user and group and unsubscribe when leaving`, async () => {
    const f = await fixture();
    try {
      const r = await route(f, platform, 'index'); const model = await f.preview.readModel();
      const chore = model.plan.chores.find((item) => item.name === 'フローリングを掃除する');
      assert.equal(f.callbacks.size, 1); assert.equal(f.calendarCallbacks.size, 1);
      await f.preview.controller.actions.patchChore(chore.id, { name: '別端末から届いた床掃除' });
      for (const callback of f.callbacks) callback({ userId: 'another-user', groupId: f.preview.groupId });
      await new Promise((resolve) => setTimeout(resolve, 120)); await r.screen.flush(); assert.equal(r.screen.text().includes('別端末から届いた床掃除'), false);
      for (const callback of f.callbacks) callback({ userId: f.preview.userId, groupId: f.preview.groupId });
      await new Promise((resolve) => setTimeout(resolve, 120)); await r.screen.flush(); assert.ok(r.screen.text().includes('別端末から届いた床掃除'));
      const before = f.calendarReads; for (const callback of f.calendarCallbacks) callback();
      for (let n = 0; n < 50 && !r.screen.text().includes('11月1日'); n++) { await new Promise(resolve => setTimeout(resolve, 20)); await r.screen.flush(); } assert.ok(f.calendarReads > before);
      const beforeLocal = f.calendarReads; assert.equal(f.localCalendarCallbacks.size, 1);
      for (const callback of f.localCalendarCallbacks) { callback('drafts'); callback('categories'); }
      await new Promise(resolve => setTimeout(resolve, 120)); await r.screen.flush(); assert.equal(f.calendarReads, beforeLocal, 'drafts and colors do not change housework allocation');
      for (const callback of f.localCalendarCallbacks) callback();
      for (let n = 0; n < 50 && !r.screen.text().includes('11月1日'); n++) { await new Promise(resolve => setTimeout(resolve, 20)); await r.screen.flush(); } assert.ok(f.calendarReads > beforeLocal);
      r.leave?.(); assert.equal(f.callbacks.size, 0); assert.equal(f.calendarCallbacks.size, 0); assert.equal(f.localCalendarCallbacks.size, 0);
    } finally { f.dispose(); }
  });
  test(`${platform} normal workspace date forms invoke the own local Calendar reader and keep private conflicts outside shared writes`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const round = model.plan.occurrences.find(row => row.activeInPeriod && row.assigneeIds.includes(f.preview.userId)); assert.ok(round);
      const params = { occurrenceId: round.id, subjectId: round.subjects[0].id, anchorDate: round.anchorDate };
      const r = await route(f, platform, 'date', params, '日時の指定');
      const fixed = r.screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '固定日時に実施');
      assert.ok(fixed); fixed.props.onPress(); await r.screen.flush();
      await r.screen.change('開始時刻', '19:00'); await r.screen.change('終了時刻', '19:30');
      for (const callback of f.appStateListeners) { callback('background'); callback('active'); }
      for (let n = 0; n < 50 && !r.screen.text().includes('11月1日'); n++) { await new Promise(resolve => setTimeout(resolve, 20)); await r.screen.flush(); }
      assert.equal(r.screen.nodes().find(node => node.props.accessibilityLabel === '開始時刻').props.value, '19:00');
      assert.equal(r.screen.nodes().find(node => node.props.accessibilityLabel === '終了時刻').props.value, '19:30');
      const before = await listSharingOutbox(f.database, f.preview.groupId); await r.screen.press('日時を指定・申請する');
      assert.equal(f.calendarChecks.length, 1); assert.match(r.screen.text(), /カレンダーに予定が入っています/u);
      assert.deepEqual(await listSharingOutbox(f.database, f.preview.groupId), before); r.leave?.();
    } finally { f.dispose(); }
  });
  test(`${platform} shared home resume after midnight refreshes the same focused page without changing formal dates or outbox`, async () => {
    const f = await fixture();
    try {
      f.setNow('2026-10-31T14:59:00Z'); const r = await route(f, platform, 'index');
      const before = await f.preview.readModel(); const outbox = await listSharingOutbox(f.database, f.preview.groupId);
      assert.ok(r.screen.text().includes('10月31日')); f.setNow('2026-10-31T15:01:00Z');
      assert.ok(f.appStateListeners.size > 0);
      const reads = f.calendarReads;
      for (let n = 0; n < 50; n++) for (const callback of f.appStateListeners) callback('active');
      for (let n = 0; n < 50 && !r.screen.text().includes('11月1日'); n++) { await new Promise(resolve => setTimeout(resolve, 20)); await r.screen.flush(); }
      assert.ok(r.screen.text().includes('11月1日'), r.screen.text());
      assert.equal(f.calendarReads, reads + 1, 'duplicate foreground signals share one refresh');
      assert.equal(r.navigation.length, 0); assert.deepEqual(await listSharingOutbox(f.database, f.preview.groupId), outbox);
      assert.equal((await f.preview.readModel()).plan.occurrences[0].anchorDate, before.plan.occurrences[0].anchorDate); r.leave?.();
    } finally { f.dispose(); }
  });
}

test('workspace navigation keeps the same main tabs for personal and v2 while protecting group detail routes', () => {
  for (const active of [null, { protocol: 1 }, { protocol: 2 }]) {
    const guards = []; const Stack = ({ children }) => children; Stack.Screen = 'StackScreen';
    Stack.Protected = ({ guard, redirectTo, children }) => { guards.push({ guard, redirectTo }); return guard ? children : null; };
    const screen = screenHarness('src/components/workspace-navigator.tsx', { exportName: 'WorkspaceNavigator', mocks: {
      'expo-router': { Stack }, '../hooks/use-workspace': { useWorkspace: () => ({ active }) } } });
    const names = screen.nodes().filter((node) => node.type === 'StackScreen').map((node) => node.props.name);
    assert.ok(names.includes('sharing')); assert.ok(names.includes('help'));
    assert.equal(names.includes('group-v2'), active?.protocol === 2); assert.equal(names.includes('(tabs)'), true);
    assert.deepEqual(guards.map((guard) => guard.redirectTo), ['/', '/sharing']);
  }
});
