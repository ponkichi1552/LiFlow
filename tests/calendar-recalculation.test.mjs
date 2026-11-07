import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { retainCalendarInputs } from '../src/features/calendar/observed-snapshot.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
const { initializeLocalDatabase, loadPlannerSnapshot, readCachedPlannerSnapshot } = await import('../src/platform/storage/repository.ts');
const { clearCalendarEditorDraft, readLocalCalendar, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent, subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');

test('draft and category observation preserves event inputs but actual edits and exception changes invalidate them', () => {
  const previous = { events: [{ id: 'one', title: 'Lesson' }], exceptions: [{ eventId: 'one', anchorDate: '2026-10-31', override: null }], categories: [{ id: 'school', color: '#123456' }], draft: null };
  const draft = { value: { title: 'Unfinished' } };
  const observed = retainCalendarInputs(previous, { ...structuredClone(previous), draft });
  assert.equal(observed.events, previous.events); assert.equal(observed.exceptions, previous.exceptions); assert.equal(observed.categories, previous.categories); assert.equal(observed.draft, draft);
  const edit = retainCalendarInputs(observed, { ...observed, events: [{ ...previous.events[0], title: 'Changed' }] });
  assert.notEqual(edit.events, observed.events); assert.equal(edit.exceptions, observed.exceptions);
  const exception = retainCalendarInputs(edit, { ...edit, exceptions: [] }); assert.notEqual(exception.exceptions, edit.exceptions);
});

test('SQLite draft and category notifications update observers without invalidating housework while saved events do invalidate it', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  await readLocalCalendar(h.database); const before = await loadPlannerSnapshot(h.database);
  const changes = []; const stop = subscribeLocalCalendar(h.database, kind => changes.push(kind)); t.after(stop);
  const draft = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: { ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: 'Test' } };
  await saveCalendarDraft(h.database, draft); assert.equal(readCachedPlannerSnapshot(h.database), before); assert.equal((await readLocalCalendar(h.database)).draft.value.title, 'Test');
  await clearCalendarEditorDraft(h.database, draft); assert.equal((await readLocalCalendar(h.database)).draft, null);
  await saveCalendarCategory(h.database, { expectedRevision: 0, name: 'Test category', color: '#123456' }); assert.equal(readCachedPlannerSnapshot(h.database), before);
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft.value }); assert.equal(readCachedPlannerSnapshot(h.database), null);
  assert.deepEqual(changes, ['drafts', 'drafts', 'categories', 'events']);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} a personal calendar keeps the same native row identity across persisted completion and Undo`, async () => {
    const { privateFixture } = await import('./helpers/sharing-v2-private-fixture.mjs');
    const { openCalendarDay } = await import('./helpers/calendar-ui.mjs');
    const { localDateFromDate } = await import('../src/domain/scheduling/local-date.ts');
    const repository = await import('../src/platform/storage/repository.ts');
    const h = await privateFixture(); let screen;
    try {
      let snapshot = await repository.loadPlannerSnapshot(h.database); const date = localDateFromDate(new Date());
      screen = screenHarness('src/app/(tabs)/explore.tsx', { platform, database: h.database, snapshot: () => snapshot });
      await openCalendarDay(screen, date);
      const identity = () => screen.nodes().find(node => node.type === 'AnimatedView')?.key;
      const original = identity(); assert.ok(original);
      const entry = snapshot.scheduleEntries.find(row => row.choreId === h.chore.id);
      const receipt = await repository.completeChoreWithReceipt(h.database, entry);
      snapshot = await repository.loadPlannerSnapshot(h.database); screen.render();
      assert.equal(identity(), original, 'committing an optimistic check must not replace its native animated row');
      await repository.undoCompletionReceipt(h.database, receipt);
      snapshot = await repository.loadPlannerSnapshot(h.database); screen.render();
      assert.equal(identity(), original, 'Undo restores the same occurrence, not a newly mounted row');
    } finally { screen?.unmount(); h.connection.close(); }
  });
  test(`${platform} replacing the restored session binding cannot erase or duplicate a pending completion`, async () => {
    const { fixture, seeds, now } = await import('./helpers/sharing-v2-repository-fixture.mjs');
    const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
    const { createV2ScreenSession } = await import('../src/features/sharing/v2-ui/screen-session.ts');
    const f = await fixture(); const d = await f.device(); let release; let completing; let screen;
    try {
      await d.repository.commit(seeds()); let writes = 0;
      const controller = createV2GroupController(d.repository, { now, makeId: () => `completion-binding-${++writes}`, sync: async () => {} });
      const wait = new Promise(resolve => { release = resolve; });
      const source = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const model = await source.readModel(); let attempts = 0;
      const session = { ...source, controller: { ...controller, actions: { ...controller.actions,
        complete: async (...args) => { attempts++; await wait; return controller.actions.complete(...args); } } } };
      const props = { purpose: 'workspace', view: 'home', lifecycleManaged: true, initialDisplay: { session, model }, loadSession: async () => session,
        onBack: () => {}, onConfiguration: () => {}, onHistory: () => {} };
      screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform, props,
        effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback() });
      await screen.flush();
      const checkbox = () => screen.nodes().find(node => node.props.accessibilityRole === 'checkbox');
      completing = checkbox().props.onPress(); await screen.flush();
      assert.equal(checkbox().props.accessibilityState.checked, true);
      props.loadSession = async () => session; screen.render(); await screen.flush();
      assert.equal(checkbox().props.accessibilityState.checked, true, 'restoring the live provider must retain the pending checkmark');
      assert.equal(attempts, 1); assert.equal(writes, 0, 'optimistic feedback must not fabricate a stored completion');
      release(); await completing; await screen.flush();
      assert.equal(attempts, 1); assert.equal(writes, 1);
      assert.equal(checkbox().props.accessibilityState.checked, true);
      assert.equal(checkbox().props.disabled, false);
    } finally { release?.(); await completing; screen?.unmount(); d.connection.close(); }
  });

  test(`${platform} background refresh keeps the saved home visible and does not reproject unchanged completion feedback`, async () => {
    const { fixture, seeds, now } = await import('./helpers/sharing-v2-repository-fixture.mjs');
    const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
    const { createV2ScreenSession } = await import('../src/features/sharing/v2-ui/screen-session.ts');
    const projection = await import('../src/features/sharing/v2-ui/calendar-projection.ts');
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds());
      const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
      const source = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const model = await source.readModel(); let resolve; let focus; let changed; let projections = 0;
      let nextRead = new Promise(done => { resolve = done; });
      const session = { ...source, readModel: () => nextRead };
      const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
        props: { purpose: 'workspace', view: 'home', lifecycleManaged: true, initialDisplay: { session, model }, loadSession: async () => session,
          subscribe: callback => { changed = callback; return () => {}; }, onBack: () => {}, onConfiguration: () => {}, onHistory: () => {} },
        focusEffect: callback => { focus = callback; },
        mocks: { './calendar-projection': { ...projection, v2CalendarProjection: (...args) => { projections++; return projection.v2CalendarProjection(...args); } } } });
      const leave = focus(); const initial = projections;
      await screen.flush(); assert.match(screen.text(), /床を掃除する/);
      assert.equal(screen.nodes().some(node => node.type === 'ActivityIndicator'), false, 'a pending refresh keeps the existing content');
      resolve(model); await screen.flush(); assert.equal(projections, initial, 'no-op refresh must retain the empty feedback map');
      const updated = { ...model, plan: { ...model.plan, chores: model.plan.chores.map(chore => ({ ...chore, name: '更新された床掃除' })) } };
      nextRead = Promise.resolve(updated); changed(); await screen.flush();
      assert.match(screen.text(), /更新された床掃除/); assert.ok(projections > initial, 'changed input must update the retained display');
      leave?.(); screen.unmount();
    } finally { d.connection.close(); }
  });

  test(`${platform} changing calendar selection or callbacks retains projected events until actual calendar inputs change`, () => {
    let value;
    const snapshot = { events: [], exceptions: [], categories: [], drafts: [], draft: null };
    const props = { local: { snapshot, refresh: async () => {} }, model: { calendar: [], plan: { groupId: 'one' }, viewerUserId: 'owner', adminUserId: 'owner' },
      actions: {}, capture: next => { value = next; } };
    const screen = screenHarness('tests/helpers/calendar-source-host.tsx', { exportName: 'CalendarSourceHost', platform, props });
    const initial = value.snapshot;
    for (let i = 0; i < 30; i++) {
      props.local = { ...props.local, refresh: async () => {} }; screen.render();
      assert.equal(value.snapshot, initial); assert.equal(value.snapshot.events, initial.events); assert.equal(value.snapshot.exceptions, initial.exceptions);
    }
    props.local = { ...props.local, snapshot: { ...snapshot, drafts: [{ audience: 'personal', value: {} }] } }; screen.render();
    assert.equal(value.snapshot.events, initial.events); assert.equal(value.snapshot.exceptions, initial.exceptions, 'draft-only updates retain recurrence inputs');
    props.local = { ...props.local, snapshot: { ...snapshot, events: [{ id: 'new-event' }] } }; screen.render();
    assert.notEqual(value.snapshot, initial); assert.equal(value.snapshot.events[0].id, 'new-event');
    const personalChanged = value.snapshot; props.model = { ...props.model, calendar: [] }; screen.render();
    assert.notEqual(value.snapshot, personalChanged, 'new shared inputs invalidate the presentation');
    props.model = { ...props.model, plan: { groupId: 'two' } }; screen.render(); assert.equal(value.shared.groupId, 'two');
  });

  test(`${platform} closing an unchanged calendar editor does not reread storage or recalculate the plan`, async () => {
    let reads = 0;
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
      props: { today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0, pending: 0 }), renderChores: () => null,
        local: { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [], draft: null }, loading: false, error: null,
          refresh: async () => { reads++; } } } });
    await selectCalendarView(screen, '1日表示'); await screen.press('予定を追加'); await screen.press('閉じる'); await screen.flush();
    assert.equal(reads, 0);
    await screen.press('予定を追加'); assert.match(screen.text(), /予定を追加/);
  });
}
