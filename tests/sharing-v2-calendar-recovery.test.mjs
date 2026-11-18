import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, seeds, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2CalendarActions } from '../src/features/sharing/v2/calendar-actions.ts';
import { createSharedCalendarRecovery } from '../src/features/calendar/shared-recovery.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { calendarFutureBase } from '../src/domain/calendar/future-series.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { calendarOccurrenceDraft } from '../src/features/calendar/direct-actions.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const { initializeLocalDatabase, withPlannerDatabaseOperation } = await import('../src/platform/storage/repository.ts');
const { calendarDraftKey, readLocalCalendar, saveCalendarDraft } = await import('../src/platform/storage/calendar-events.ts');
const { calendarReminderMinutes, calendarReminderScope, readCalendarReminders, recoverCalendarReminderUndos, saveCalendarReminder } = await import('../src/platform/storage/calendar-reminders.ts');

const category = { id: 'personal', name: '私用', color: '#348DC2', revision: 1 };
const draft = extra => ({ ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: 'Shared event', recurrence: 'weekly', ...extra });
const basis = record => JSON.stringify([record.heads.map(op => op.operationId).sort(), record.heads.map(op => op.operationId).sort()]);

test('shared series moves preserve individual dates in one batch and a single-occurrence undo leaves other exceptions intact', async () => {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds()); let id = 0;
  const actions = createV2CalendarActions(d.repository, () => `preserve-series-${++id}`);
  const records = async () => readSharedCalendar((await d.repository.readState()).assessment.view);
  await actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: draft(), category });
  let record = (await records())[0]; const eventId = record.id;
  for (const [anchor, date] of [['2026-11-03', '2026-11-05'], ['2026-11-10', '2026-11-12']]) {
    record = (await records())[0];
    await actions.saveCalendarEvent({ eventId, scope: 'one', anchorDate: anchor,
      basisRevision: JSON.stringify([record.heads.map(row => row.operationId).sort(), []]), value: draft({ title: `個別 ${anchor}`, recurrence: 'none', startDate: date, endDate: date }), category });
  }
  record = (await records())[0];
  await actions.saveCalendarEvent({ eventId, scope: 'series', anchorDate: null, basisRevision: basis(record),
    value: draft({ startDate: '2026-10-28', endDate: '2026-10-28' }), category });
  record = (await records())[0];
  assert.deepEqual(record.exceptions.map(row => row.anchorDate), ['2026-11-04', '2026-11-11']);
  assert.deepEqual(record.exceptions.map(row => row.heads[0].payload.value.startDate), ['2026-11-05', '2026-11-12']);
  const one = record.exceptions[0];
  for (const invalid of [{ scope: 'one', anchorDate: one.anchorDate }, { eventId, scope: 'series', anchorDate: one.anchorDate }, { eventId, scope: 'one', anchorDate: null }]) {
    assert.throws(() => actions.restoreCalendarOccurrence({ ...invalid, value: null, category: null }), /予定を選んで/u);
  }
  await actions.restoreCalendarOccurrence({ eventId, scope: 'one', anchorDate: one.anchorDate, value: null, category: null,
    basisRevision: JSON.stringify([record.heads.map(row => row.operationId).sort(), one.heads.map(row => row.operationId).sort()]) });
  const after = (await records())[0]; assert.deepEqual(after.exceptions.map(row => row.anchorDate), ['2026-11-11']);
  await assert.rejects(actions.restoreCalendarOccurrence({ eventId, scope: 'one', anchorDate: one.anchorDate, value: null, category: null,
    basisRevision: JSON.stringify([record.heads.map(row => row.operationId).sort(), one.heads.map(row => row.operationId).sort()]) }), /更新/);
});

async function sharedEditorFixture(platform) {
  const f = await fixture(); const d = await f.device(); const local = createDatabase(); let ordinal = 0;
  await d.repository.commit(seeds()); await initializeLocalDatabase(local.database);
  const actions = { ...createV2CalendarActions(d.repository, () => `durable-calendar-${++ordinal}`), ...createSharedCalendarRecovery(d.repository) };
  const records = async () => readSharedCalendar((await d.repository.readState()).assessment.view);
  const readDrafts = (user = 'owner') => readLocalCalendar(local.database, calendarReminderScope(user, d.options.groupId));
  const open = async (overrides = {}) => {
    let binding;
    const model = { viewerUserId: 'owner', adminUserId: 'owner', calendarSupported: true,
      plan: { groupId: d.options.groupId }, calendar: await records() };
    const props = { local: { database: local.database, snapshot: await readDrafts(overrides.model?.viewerUserId), refresh: async () => {}, error: null, loading: false },
      model, actions, perform: async work => {
        try { await work(); return { committed: true, refreshed: true }; }
        catch (error) { return { committed: false, refreshed: false, error }; }
      }, capture: value => { binding = value; }, ...overrides };
    const screen = screenHarness('tests/helpers/calendar-source-host.tsx', { exportName: 'CalendarSourceHost', platform, props, effectDependencies: true, layoutEffect: fn => fn() });
    return { get binding() { screen.render(); return binding; }, props, screen };
  };
  const input = (user = 'owner') => ({ audience: 'group', groupId: d.options.groupId, ownerScope: calendarReminderScope(user, d.options.groupId), eventId: null, anchorDate: null,
    revision: 0, exceptionRevision: 0, scope: 'series', value: draft() });
  return { ...f, d, local, actions, records, open, input, readDrafts, close() { d.connection.close(); local.connection.close(); } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} switching accounts inside the same group isolates unsent calendar drafts and restores each owners own draft`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    const owner = await f.open(); t.after(() => owner.screen.unmount());
    const legacy = { ...f.input(), ownerScope: undefined, value: draft({ title: '旧形式' }) };
    await f.local.database.runAsync('INSERT INTO calendar_drafts(slot,draft_json) VALUES(?,?)', calendarDraftKey(legacy), JSON.stringify(legacy));
    const oldRow = await f.local.database.getFirstAsync('SELECT slot,draft_json FROM calendar_drafts');
    await assert.rejects(owner.binding.persistDraft(legacy), /アカウント/u);
    const categoryId = await owner.binding.saveCategory({ name: '未共有の分類', color: '#31648A', expectedRevision: 0 }, 'group');
    const first = { ...f.input(), value: draft({ title: '最初の下書き', categoryId }) }; await owner.binding.persistDraft(first);
    const saved = (await f.readDrafts()).draft;
    const model = { viewerUserId: 'member', adminUserId: 'owner', calendarSupported: true, plan: { groupId: f.d.options.groupId }, calendar: await f.records() };
    let submissions = 0;
    const actions = { ...f.actions, async saveCalendarEvent() { submissions++; throw new Error('unexpected write'); } };
    const member = await f.open({ model, actions }); t.after(() => member.screen.unmount());
    assert.equal(member.binding.snapshot.drafts.length, 0);
    assert.equal(member.binding.categoriesFor('group').some(row => row.id === categoryId), false);
    await assert.rejects(member.binding.saveEvent(saved, false), /アカウント|本人/u); assert.equal(submissions, 0);
    const second = { ...f.input('member'), value: draft({ title: '次の下書き' }) }; await member.binding.persistDraft(second);
    const ownerAgain = await f.open(), memberAgain = await f.open({ model, actions });
    t.after(() => { ownerAgain.screen.unmount(); memberAgain.screen.unmount(); });
    assert.deepEqual(ownerAgain.binding.snapshot.drafts.map(row => row.value.title), [first.value.title]);
    assert.deepEqual(memberAgain.binding.snapshot.drafts.map(row => row.value.title), [second.value.title]);
    assert.ok(ownerAgain.binding.categoriesFor('group').some(row => row.id === categoryId));
    assert.deepEqual(await f.local.database.getFirstAsync('SELECT slot,draft_json FROM calendar_drafts WHERE slot=?', oldRow.slot), oldRow);
    assert.equal((await f.local.database.getFirstAsync('SELECT COUNT(*) AS total FROM calendar_drafts')).total, 3); assert.equal((await f.records()).length, 0);
  });

  test(`${platform} an account switch while editing a shared event stops queued draft writes and deferred signed submissions`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    await f.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: draft(), category });
    const waiting = Promise.withResolvers(), release = Promise.withResolvers();
    const host = await f.open({ perform: async work => {
      waiting.resolve(); await release.promise;
      try { await work(); return { committed: true, refreshed: true }; }
      catch (error) { return { committed: false, refreshed: false, error }; }
    } });
    t.after(() => { release.resolve(); host.screen.unmount(); });
    const owner = host.binding, event = owner.snapshot.events.find(row => row.id.startsWith('group.'));
    const edit = owner.prepareDraft({ eventId: event.id, anchorDate: '2026-11-03', revision: event.revision, exceptionRevision: 0,
      scope: 'one', value: draft({ title: '入力中のこの回', startDate: '2026-11-03', endDate: '2026-11-03', recurrence: 'none' }) });
    assert.equal(edit.ownerScope, calendarReminderScope('owner', f.d.options.groupId));
    await owner.persistDraft(edit);
    const deferred = owner.saveEvent(edit, false);
    await waiting.promise;
    const before = await f.readDrafts();
    const gate = Promise.withResolvers(), held = withPlannerDatabaseOperation(f.local.database, () => gate.promise);
    const queued = owner.persistDraft({ ...edit, value: { ...edit.value, notes: '遅延した保存' } });
    host.props.model = { ...host.props.model, viewerUserId: 'member' };
    host.props.local = { ...host.props.local, snapshot: before };
    const next = host.binding;
    assert.deepEqual(next.snapshot.drafts, []);
    assert.throws(() => next.prepareDraft(edit), /アカウント/u);
    assert.equal(next.canEditEvent(event.id), false);
    const refused = Promise.all([assert.rejects(queued, /アカウント/u), assert.rejects(deferred, /アカウント/u)]);
    gate.resolve(); release.resolve(); await Promise.all([held, refused]);
    assert.deepEqual((await f.readDrafts()).drafts, before.drafts);
    const record = (await f.records())[0];
    assert.equal(record.heads.length, 1); assert.equal(record.exceptions.length, 0);
    const restored = await f.open(); t.after(() => restored.screen.unmount());
    assert.deepEqual(restored.binding.snapshot.drafts, before.drafts);
    await restored.binding.saveEvent(restored.binding.snapshot.draft, false);
    assert.deepEqual((await f.records())[0].exceptions.map(row => row.anchorDate), [edit.anchorDate]);
    assert.equal((await f.readDrafts()).draft, null);
  });

  test(`${platform} a resumed shared future draft refuses a newly received exception but a one occurrence edit may keep the unrelated change`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    const member = await f.device('member', f.member); t.after(() => member.connection.close());
    const groupId = f.d.options.groupId;
    const deliver = async (from, to) => {
      const facts = await loadSharedFacts(from.database, groupId), checkpoint = await readSharingCheckpoint(to.database, groupId);
      await applyReceivedSharedFacts(to.database, groupId, facts, String(facts.length), to.repository.project, checkpoint.cursor,
        now().getTime(), to.repository.evidenceForServerReceipts(receiptsFor(facts)));
    };
    await deliver(f.d, member);
    let id = 0; const author = createV2CalendarActions(member.repository, () => `companion-calendar-${++id}`);
    const [creation] = await author.saveCalendarEvent({ scope: 'series', anchorDate: null, value: draft(), category });
    await deliver(member, f.d);
    const host = await f.open(); t.after(() => host.screen.unmount());
    const local = host.binding, parent = local.snapshot.events.find(row => row.id.startsWith('group.')), anchor = '2026-11-03';
    const pending = local.prepareDraft({ eventId: parent.id, anchorDate: anchor, revision: parent.revision, exceptionRevision: 0, scope: 'future',
      value: { ...calendarFutureBase(parent, anchor), location: 'ローカルの編集' } });
    await local.persistDraft(pending);
    const otherDay = '2026-11-10', remoteValue = draft({ title: '相手が保存した回', startDate: otherDay, endDate: otherDay, recurrence: 'none' });
    await author.saveCalendarEvent({ eventId: creation.operationId, scope: 'one', anchorDate: otherDay, basisRevision: JSON.stringify([[creation.operationId], []]),
      value: remoteValue, category });
    await deliver(member, f.d);
    const resumed = await f.open(); t.after(() => resumed.screen.unmount());
    const client = resumed.binding, prior = await f.records(), input = client.snapshot.draft, facts = await loadSharedFacts(f.d.database, groupId);
    await assert.rejects(client.saveEvent(input, false), /更新/u);
    assert.deepEqual(await loadSharedFacts(f.d.database, groupId), facts); assert.deepEqual(await f.records(), prior);
    assert.deepEqual((await f.readDrafts()).draft.value, pending.value);
    const one = { ...input, scope: 'one', value: { ...input.value, recurrence: 'none', untilDate: null } };
    await client.saveEvent(one, false);
    const [current] = await f.records();
    assert.deepEqual(current.heads, prior[0].heads);
    assert.deepEqual(current.exceptions.find(row => row.anchorDate === otherDay), prior[0].exceptions.find(row => row.anchorDate === otherDay));
    assert.equal(current.exceptions.find(row => row.anchorDate === anchor).heads[0].payload.value.location, one.value.location);
  });

  test(`${platform} undoing a shared future move keeps both the split and private rules when another editor changes reminders or local restoration fails`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    await f.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: draft(), category });
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    let pauseUndo = false, rejectSignature = false;
    const host = await f.open({ actions: { ...f.actions, undoCalendarFutureEvent(command) {
      if (rejectSignature) throw new Error('synthetic signing failure');
      return f.actions.undoCalendarFutureEvent(command);
    } }, perform: async work => {
      if (pauseUndo) { pending.resolve(); await release.promise; }
      try { await work(); return { committed: true, refreshed: true }; }
      catch (error) { return { committed: false, refreshed: false, error }; }
    } });
    t.after(() => { release.resolve(); host.screen.unmount(); });
    const binding = host.binding, source = binding.snapshot.events[0], anchor = '2026-11-03';
    const groupId = f.d.options.groupId, scope = calendarReminderScope('owner', groupId);
    await saveCalendarReminder(f.local.database, { scope, eventId: source.id, anchorDate: null, minutes: 60 });
    const before = await readCalendarReminders(f.local.database);
    const input = binding.prepareDraft({ eventId: source.id, anchorDate: anchor, revision: source.revision, exceptionRevision: 0,
      scope: 'future', value: calendarFutureBase(source, anchor) });
    const receipt = await binding.saveEvent(input, false);
    assert.equal(typeof receipt?.undoFuture, 'function');
    const after = await loadSharedFacts(f.d.database, groupId);
    const branch = (await readCalendarReminders(f.local.database)).rules.find(row => row.eventId !== source.id);
    assert.ok(branch); pauseUndo = true;
    const refused = assert.rejects(receipt.undoFuture(), /通知設定が更新/u);
    await pending.promise;
    await saveCalendarReminder(f.local.database, { ...branch, minutes: 10 });
    const concurrent = await readCalendarReminders(f.local.database);
    release.resolve(); await refused;
    assert.deepEqual(await readCalendarReminders(f.local.database), concurrent);
    assert.equal((await loadSharedFacts(f.d.database, groupId)).length, after.length, 'a refused undo must leave the signed split intact');
    pauseUndo = false;
    await saveCalendarReminder(f.local.database, branch);
    const originalRun = f.local.database.runAsync;
    f.local.database.runAsync = async (sql, ...params) => {
      if (sql.startsWith('DELETE FROM calendar_notification_rules')) throw new Error('synthetic disk failure');
      return originalRun(sql, ...params);
    };
    try { await assert.rejects(receipt.undoFuture(), /synthetic disk failure/u); }
    finally { f.local.database.runAsync = originalRun; }
    assert.deepEqual(await loadSharedFacts(f.d.database, groupId), after);
    const afterRules = await readCalendarReminders(f.local.database);
    rejectSignature = true; await assert.rejects(receipt.undoFuture(), /synthetic signing failure/u); rejectSignature = false;
    await recoverCalendarReminderUndos(f.local.database, scope, f.actions.appliedCalendarReminderUndo, () => {});
    assert.deepEqual(await loadSharedFacts(f.d.database, groupId), after); assert.deepEqual(await readCalendarReminders(f.local.database), afterRules);
    await receipt.undoFuture(); const undone = await loadSharedFacts(f.d.database, groupId);
    assert.ok(undone.length > after.length); assert.deepEqual(await readCalendarReminders(f.local.database), before);
    await receipt.undoFuture(); assert.deepEqual(await loadSharedFacts(f.d.database, groupId), undone);
  });

  test(`${platform} restarting after the signed future undo repairs the same device's private reminders without signing again`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    await f.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: draft(), category });
    const dir = mkdtempSync(join(tmpdir(), 'liflow-calendar-undo-restart-')), path = join(dir, 'personal.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let h = createDatabase(path); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const groupId = f.d.options.groupId, scope = calendarReminderScope('owner', groupId);
    let signed = false;
    const editor = await f.open({ local: { database: h.database, snapshot: await readLocalCalendar(h.database, scope), refresh: async () => {} },
      actions: { ...f.actions, async undoCalendarFutureEvent(command) { const result = await f.actions.undoCalendarFutureEvent(command); signed = true; return result; } } });
    const binding = editor.binding, source = binding.snapshot.events[0], anchor = '2026-11-03', future = '2026-11-10', later = '2026-11-17';
    await saveCalendarReminder(h.database, { scope, eventId: source.id, anchorDate: null, minutes: 60 });
    await saveCalendarReminder(h.database, { scope, eventId: source.id, anchorDate: future, minutes: 10 });
    await saveCalendarReminder(h.database, { scope, eventId: source.id, anchorDate: later, minutes: null });
    const original = await readCalendarReminders(h.database);
    const receipt = await binding.saveEvent(binding.prepareDraft({ eventId: source.id, anchorDate: anchor, revision: source.revision, exceptionRevision: 0,
      scope: 'future', value: calendarFutureBase(source, anchor) }), false);
    const normal = h.database.withTransactionAsync;
    h.database.withTransactionAsync = callback => normal(async () => { await callback(); if (signed) throw new Error('interrupted private COMMIT'); });
    try { await assert.rejects(receipt.undoFuture(), /interrupted private COMMIT/u); }
    finally { h.database.withTransactionAsync = normal; editor.screen.unmount(); }
    assert.ok(signed); const facts = await loadSharedFacts(f.d.database, groupId);
    h.connection.close(); h = createDatabase(path);
    await saveCalendarReminder(h.database, { scope, eventId: source.id, anchorDate: later, minutes: 1440 });
    const waiting = await readCalendarReminders(h.database);
    assert.equal(calendarReminderMinutes(waiting, scope, source.id, future), 60);
    const auth = { currentUser: { uid: 'member' }, onAuthStateChanged: () => () => {} };
    const session = { controller: { actions: f.actions } };
    const identity = userId => ({ ready: true, userId, group: { groupId, userId, status: 'active' }, active: { protocol: 2, userId, groupId, session } });
    const workspace = { _currentValue: identity('member') };
    const observer = screenHarness('tests/helpers/local-calendar-observer-host.tsx', { exportName: 'LocalCalendarObserverHost', platform,
      effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(), props: { database: h.database, capture() {} },
      mocks: { '@/contexts/workspace-context': { WorkspaceContext: workspace }, './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
        '@/platform/sharing/firebase-services': { isSharingConfigured: () => true, getSharingServices: () => ({ auth }) } } });
    t.after(() => observer.unmount()); await observer.flush();
    assert.deepEqual(await readCalendarReminders(h.database), waiting);
    workspace._currentValue = identity('owner'); auth.currentUser = { uid: 'owner' }; observer.render();
    for (let n = 0; n < 20 && calendarReminderMinutes(await readCalendarReminders(h.database), scope, source.id, future) !== 10; n++) await observer.flush();
    const recovered = await readCalendarReminders(h.database);
    const sorted = rows => [...rows].sort((a, b) => String(a.anchorDate).localeCompare(String(b.anchorDate)));
    assert.deepEqual(sorted(recovered.rules), sorted(original.rules.map(row => row.anchorDate === later ? { ...row, minutes: 1440 } : row)));
    assert.equal((await h.database.getFirstAsync('SELECT count(*) AS n FROM calendar_reminder_undos')).n, 0);
    assert.deepEqual(await loadSharedFacts(f.d.database, groupId), facts);
  });

  test(`${platform} restarting after a lost shared future split reply recovers private reminders from the original series exactly once`, async t => {
    for (const anchor of ['2026-10-27', '2026-11-03']) {
      const f = await sharedEditorFixture(platform); t.after(() => f.close());
      await (await f.open()).binding.saveEvent(f.input(), false);
      const source = await f.open({ actions: { ...f.actions, async saveCalendarEvent(command) {
        await f.actions.saveCalendarEvent(command); throw new Error('synthetic lost split reply');
      } } }); t.after(() => source.screen.unmount());
      const local = source.binding, parent = local.snapshot.events.find(row => row.id.startsWith('group.'));
      const scope = calendarReminderScope('owner', f.d.options.groupId), nextDay = addDays(anchor, 1), following = addDays(anchor, 7);
      await saveCalendarReminder(f.local.database, { scope, eventId: parent.id, anchorDate: null, minutes: 60 });
      await saveCalendarReminder(f.local.database, { scope, eventId: parent.id, anchorDate: following, minutes: 10 });
      const edit = local.prepareDraft({ eventId: parent.id, anchorDate: anchor, revision: parent.revision, exceptionRevision: 0, scope: 'future',
        value: { ...calendarFutureBase(parent, anchor), startDate: nextDay, endDate: nextDay, location: '合成会場' } });
      await assert.rejects(local.saveEvent(edit, false), /lost split reply/u);
      const committed = await f.records(); assert.equal(committed.length, 2);
      const outbox = () => f.d.connection.prepare('SELECT COUNT(*) AS n FROM sharing_outbox').get().n;
      const beforeRetry = outbox(), current = await f.open(); t.after(() => current.screen.unmount());
      const resumed = current.binding, saved = (await f.readDrafts()).draft;
      const branch = resumed.snapshot.events.find(row => row.id !== parent.id); assert.ok(branch); assert.ok(saved?.submission);
      const chosenAfterSplit = anchor !== parent.startDate;
      if (chosenAfterSplit) await saveCalendarReminder(f.local.database, { scope, eventId: branch.id, anchorDate: null, minutes: 0 });
      const canRetry = async () => resumed.saveEvent(saved, false);
      await canRetry(); assert.equal((await f.readDrafts()).draft, null);
      const rules = async () => (await readCalendarReminders(f.local.database)).rules.filter(row => row.scope === scope);
      const after = await rules();
      assert.ok(after.some(row => row.eventId === branch.id && row.anchorDate === null && row.minutes === (chosenAfterSplit ? 0 : 60)));
      assert.ok(after.some(row => row.eventId === branch.id && row.anchorDate === addDays(following, 1) && row.minutes === 10));
      assert.ok(!after.some(row => row.eventId === parent.id && row.anchorDate === following));
      await canRetry(); assert.deepEqual(await rules(), after); assert.deepEqual(await f.records(), committed); assert.equal(outbox(), beforeRetry);
    }
  });

  test(`${platform} a resumed shared occurrence draft keeps its edits and saves the latest exact location once on the future branch`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    const parent = draft({ title: '週の予定', location: '本館', notes: '毎週のメモ' });
    await f.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: parent, category });
    const [record] = await f.records(), anchor = '2026-11-03', moved = '2026-11-04';
    const override = draft({ title: '個別予定', location: '別館', notes: 'この回のメモ', startDate: moved, endDate: moved, recurrence: 'none' });
    await f.actions.saveCalendarEvent({ eventId: record.id, scope: 'one', anchorDate: anchor,
      basisRevision: JSON.stringify([[record.id], []]), value: override, category });

    const source = await f.open(); t.after(() => source.screen.unmount()); const local = source.binding;
    const [occurrence] = projectCalendarEvents(local.snapshot.events, local.snapshot.exceptions, moved, moved);
    const initial = local.prepareDraft(calendarOccurrenceDraft(occurrence, true));
    const editor = (initial, local, callbacks) => {
      const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial, local, onClose() {}, onSaved() {}, ...callbacks } });
      t.after(() => ui.unmount()); return ui;
    };
    let closed = 0;
    const first = editor(initial, local, { onClose() { closed++; } });
    await first.change('予定の場所', '長い下書きの場所');
    await first.change('予定のメモ', '再開前のメモ');
    await first.press('予定の編集を閉じる'); await first.press('下書き保存');
    for (let i = 0; i < 20 && !closed; i++) await first.flush();
    assert.equal(closed, 1);

    const sourceAfterRestart = await f.open(); t.after(() => sourceAfterRestart.screen.unmount());
    const restarted = sourceAfterRestart.binding; let saves = 0;
    const form = editor(restarted.snapshot.draft, restarted, { onSaved() { saves++; } });
    await form.press('変更する範囲を選択'); await form.press('今後の予定すべて');
    const location = () => form.nodes().find(row => row.type === 'TextInput' && row.props.accessibilityLabel === '予定の場所').props;
    assert.equal(location().value ?? location().defaultValue, '長い下書きの場所');
    await form.change('予定の場所', parent.location);
    await form.press('変更する範囲を選択'); await form.press('この予定だけ');
    assert.equal(location().value ?? location().defaultValue, parent.location);
    await form.press('変更する範囲を選択'); await form.press('今後の予定すべて');
    const before = await f.records(); assert.equal(before.length, 1); assert.equal(before[0].heads[0].payload.value.location, '本館');
    const save = form.button('予定を保存');
    const finalLocation = '共有会議室 Ｂ棟２階 西口前';
    location().onChangeText(finalLocation + 'desk'); location().onChangeText(finalLocation);
    save.props.onPress(); save.props.onPress();
    for (let i = 0; i < 50 && !saves; i++) await form.flush();
    assert.equal(saves, 1, form.text());
    const records = await f.records(); assert.equal(records.length, 2);
    const branch = records.find(row => row.id !== record.id), past = records.find(row => row.id === record.id);
    assert.deepEqual(branch.heads[0].payload.value, { ...parent, startDate: anchor, endDate: anchor, location: finalLocation, notes: '再開前のメモ' });
    assert.deepEqual(branch.exceptions[0].heads[0].payload.value, override);
    assert.deepEqual(past.heads[0].payload.value, { ...parent, untilDate: '2026-11-02' });
    assert.equal((await f.readDrafts()).draft, null);
  });

  test(`${platform} editing moving and deleting a detached shared occurrence of a single event changes only that occurrence`, async t => {
    const f = await sharedEditorFixture(platform); t.after(() => f.close());
    const parent = draft({ title: '残す親予定', location: '親の場所' });
    await f.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: parent, category });
    const [record] = await f.records(), anchor = '2026-11-03', moved = '2026-11-05';
    const override = draft({ title: '残した個別予定', location: '個別の場所', startDate: moved, endDate: moved, recurrence: 'none' });
    await f.actions.saveCalendarEvent({ eventId: record.id, scope: 'one', anchorDate: anchor, basisRevision: JSON.stringify([[record.id], []]), value: override, category });
    await f.actions.saveCalendarEvent({ eventId: record.id, scope: 'one', anchorDate: '2026-11-10', basisRevision: JSON.stringify([[record.id], []]),
      value: draft({ title: 'もう一つの個別予定', startDate: '2026-11-12', endDate: '2026-11-12', recurrence: 'none' }), category });
    await f.actions.saveCalendarEvent({ eventId: record.id, scope: 'series', anchorDate: null, basisRevision: basis(record), value: { ...parent, recurrence: 'none' }, category });
    const [baseline] = await f.records(); let confirm;
    const member = await f.open({ model: { viewerUserId: 'member', adminUserId: 'owner', calendarSupported: true, plan: { groupId: f.d.options.groupId }, calendar: [baseline] } });
    t.after(() => member.screen.unmount());
    const memberLocal = member.binding;
    const [memberOccurrence] = projectCalendarEvents(memberLocal.snapshot.events, memberLocal.snapshot.exceptions, moved, moved);
    const memberDraft = memberLocal.prepareDraft(calendarOccurrenceDraft(memberOccurrence, false));
    assert.equal(memberLocal.canEditEvent(memberDraft.eventId, anchor), false);
    await assert.rejects(memberLocal.saveEvent(memberDraft, false), /作成者または管理者/);
    await assert.rejects(memberLocal.deleteEvent(memberDraft), /作成者または管理者/);
    const openDay = async () => {
      const host = await f.open(); t.after(() => host.screen.unmount());
      const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: callback => callback(),
        alert: (_title, _message, options) => { confirm = options.find(option => option.style === 'destructive'); }, props: {
          local: host.binding, today: moved, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
        } });
      t.after(() => ui.unmount()); await selectCalendarView(ui, '1日表示'); return ui;
    };
    const verify = async (ui, expected) => {
      let record, target;
      for (let i = 0; i < 50; i++) {
        await ui.flush(); [record] = await f.records();
        target = record.exceptions.find(row => row.anchorDate === anchor);
        if (isDeepStrictEqual(target?.heads[0].payload.value, expected)) break;
      }
      assert.deepEqual(record.heads, baseline.heads);
      assert.deepEqual(record.exceptions.filter(row => row.anchorDate !== anchor), baseline.exceptions.filter(row => row.anchorDate !== anchor));
      assert.deepEqual(target.heads[0].payload.value, expected);
    };
    const edited = { ...override, location: '変更後の場所' };
    const form = await openDay(); await form.press('残した個別予定を編集');
    await form.change('予定の場所', edited.location); await form.press('予定を保存'); await verify(form, edited);
    const day = await openDay(); day.button('残した個別予定を編集').props.onLongPress(); await day.flush();
    const card = day.nodes().find(node => node.props.testID?.startsWith('calendar-movable-'));
    card.props.onPanResponderGrant(); card.props.onPanResponderRelease(null, { dx: 0, dy: 44 });
    await verify(day, { ...edited, startMinute: 600, endMinute: 660 });
    const removal = await openDay(); await removal.press('残した個別予定を編集');
    assert.ok(!removal.nodes().some(node => node.props.accessibilityLabel === '繰り返しを選択'));
    await removal.press('この回を削除');
    assert.ok(confirm); confirm.onPress(); await verify(removal, null);
  });

  test(`${platform} a committed shared calendar save survives draft-cleanup failure and restart without duplicating a series`, async () => {
    const f = await sharedEditorFixture(platform);
    try {
      const editor = await f.open(); const input = f.input();
      const run = f.local.database.runAsync; let failCleanup = true;
      f.local.database.runAsync = async (sql, ...params) => {
        if (failCleanup && sql.startsWith('DELETE FROM calendar_drafts WHERE slot=? AND draft_json=?')) throw new Error('synthetic cleanup unavailable');
        return run(sql, ...params);
      };
      await editor.binding.saveEvent(input, false);
      assert.equal((await f.records()).length, 1);
      assert.match(editor.binding.error, /予定は保存済み/);
      await editor.binding.refresh(); assert.match(editor.binding.error, /予定は保存済み/);
      const restored = (await f.readDrafts()).draft; assert.ok(restored.submission);
      const restarted = await f.open(); failCleanup = false;
      await restarted.binding.saveEvent(restored, false);
      assert.equal((await f.records()).length, 1);
      assert.equal(f.d.connection.prepare('SELECT count(*) AS n FROM sharing_v2_mutation_intents').get().n, 1);
      assert.equal((await f.readDrafts()).draft, null);
      // A genuinely new event with identical content is a separate user action.
      await (await f.open()).binding.saveEvent(f.input(), false);
      assert.equal((await f.records()).length, 2);
    } finally { f.close(); }
  });
  test(`${platform} shared calendar post-commit cleanup preserves a newer draft saved by another editor`, async () => {
    const f = await sharedEditorFixture(platform);
    try {
      const newer = { ...f.input(), value: draft({ title: 'New unsaved event' }) };
      const editor = await f.open({ actions: { ...f.actions, saveCalendarEvent: async command => {
        const result = await f.actions.saveCalendarEvent(command);
        await saveCalendarDraft(f.local.database, newer, false, editor.binding.assertDraftAccess); return result;
      } } });
      await editor.binding.saveEvent(f.input(), false);
      assert.equal((await f.records()).length, 1);
      assert.deepEqual((await f.readDrafts()).draft, newer);
    } finally { f.close(); }
  });
  test(`${platform} a lost shared calendar commit reply retries the persisted command and failed pre-commit saves retain their draft`, async () => {
    const f = await sharedEditorFixture(platform);
    try {
      let before = true; let lostReply = true;
      const editor = await f.open({ actions: { ...f.actions, saveCalendarEvent: async command => {
        if (before) throw new Error('before commit');
        const result = await f.actions.saveCalendarEvent(command);
        if (lostReply) throw new Error('commit reply lost'); return result;
      } } });
      const input = { ...f.input(), submission: { id: 'calendar-intent.previous-restored-command', digest: '0'.repeat(64) } };
      await assert.rejects(editor.binding.saveEvent(input, false), /before commit/);
      assert.equal((await f.records()).length, 0); assert.ok((await f.readDrafts()).draft);
      before = false;
      await assert.rejects(editor.binding.saveEvent(input, false), /reply lost/);
      assert.equal((await f.records()).length, 1);
      lostReply = false;
      await editor.binding.saveEvent(input, false);
      assert.equal((await f.records()).length, 1, 'an edited restored draft must reuse the current attempt instead of its obsolete submission');
      // Closing after recovery must persist the current submission, not the
      // obsolete identity that came with the original restored draft.
      await editor.binding.persistDraft(input);
      const restored = (await f.readDrafts()).draft;
      await (await f.open()).binding.saveEvent(restored, false);
      assert.equal((await f.records()).length, 1); assert.equal((await f.readDrafts()).draft, null);
    } finally { f.close(); }
  });
  test(`${platform} edits and deletion retry the committed shared intent using the projected event identity and original basis`, async () => {
    const f = await sharedEditorFixture(platform);
    try {
      await (await f.open()).binding.saveEvent(f.input(), false);
      let editor = await f.open(); const event = editor.binding.snapshot.events.find(row => row.id.startsWith('group.'));
      const input = editor.binding.prepareDraft({ ...f.input(), audience: undefined, groupId: undefined, eventId: event.id,
        revision: event.revision, value: { ...event, title: 'Edited shared event' } });
      const run = f.local.database.runAsync; let failCleanup = true;
      f.local.database.runAsync = async (sql, ...params) => {
        if (failCleanup && sql.startsWith('DELETE FROM calendar_drafts WHERE slot=? AND draft_json=?')) throw new Error('cleanup unavailable');
        return run(sql, ...params);
      };
      await editor.binding.saveEvent(input, false);
      const restored = (await f.readDrafts()).draft;
      failCleanup = false; editor = await f.open(); await editor.binding.saveEvent(restored, false);
      let record = (await f.records())[0]; assert.equal(record.heads[0].payload.value.title, 'Edited shared event');
      assert.equal((await f.d.repository.readState()).replica.operations.filter(row => row.entityType === 'calendarEvent').length, 2);
      editor = await f.open(); const updated = editor.binding.snapshot.events.find(row => row.id === event.id);
      const remove = editor.binding.prepareDraft({ ...f.input(), audience: undefined, groupId: undefined, eventId: updated.id,
        revision: updated.revision, value: updated });
      failCleanup = true; await editor.binding.deleteEvent(remove);
      const retryDelete = (await f.readDrafts()).draft;
      failCleanup = false; editor = await f.open(); await editor.binding.deleteEvent(retryDelete);
      record = (await f.records())[0]; assert.equal(record.heads[0].payload.value, null);
      assert.equal((await f.d.repository.readState()).replica.operations.filter(row => row.entityType === 'calendarEvent').length, 3);
      assert.equal((await f.readDrafts()).draft, null);
    } finally { f.close(); }
  });
}

test('shared calendar intent identity rejects a different command and captures nested input before asynchronous access checks', async () => {
  const f = await fixture(); const d = await f.device(); let ordinal = 0;
  try {
    await d.repository.commit(seeds());
    const actions = createV2CalendarActions(d.repository, () => `captured-calendar-${++ordinal}`);
    const command = { intentId: 'calendar-intent.synthetic-retry', scope: 'series', anchorDate: null, value: draft(), category: { ...category } };
    const pending = actions.saveCalendarEvent(command); command.value.title = 'mutated after click'; command.category.color = '#FF0000';
    await pending;
    const record = readSharedCalendar((await d.repository.readState()).assessment.view)[0];
    assert.equal(record.heads[0].payload.value.title, 'Shared event'); assert.equal(record.heads[0].payload.category.color, category.color);
    await assert.rejects(actions.saveCalendarEvent(command), /一致しません/);
    await assert.rejects(d.repository.commitCalendarIntent({ id: 'calendar-intent.unauthorized', digest: 'a'.repeat(64) }, async () => [
      { operationId: 'calendar-unrelated-edit', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: 'not a calendar event' } }]), /別の設定/);
    assert.equal(d.connection.prepare('SELECT count(*) AS n FROM sharing_v2_mutation_intents').get().n, 1);
  } finally { d.connection.close(); }
});

test('shared recurring exception resets refuse changes not included in the originally reviewed exception set', async () => {
  const f = await fixture(); const d = await f.device(); let ordinal = 0;
  try {
    await d.repository.commit(seeds());
    const actions = createV2CalendarActions(d.repository, () => `calendar-reset-review-${++ordinal}`);
    const [created] = await actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: draft(), category });
    const records = async () => readSharedCalendar((await d.repository.readState()).assessment.view)[0];
    const first = await records();
    await actions.saveCalendarEvent({ eventId: created.operationId, scope: 'one', anchorDate: '2026-11-03',
      basisRevision: JSON.stringify([first.heads.map(op => op.operationId), []]), value: draft({ title: 'First exception' }), category });
    const reviewed = await records(); const reviewedIds = reviewed.exceptions.flatMap(row => row.heads.map(op => op.operationId));
    await actions.saveCalendarEvent({ eventId: created.operationId, scope: 'one', anchorDate: '2026-11-10',
      basisRevision: JSON.stringify([first.heads.map(op => op.operationId), []]), value: draft({ title: 'New unseen exception' }), category });
    const before = d.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n;
    await assert.rejects(actions.saveCalendarEvent({ eventId: created.operationId, scope: 'series', anchorDate: null,
      basisRevision: basis(reviewed), value: draft({ recurrence: 'biweekly' }), category, resetExceptions: true, expectedExceptionIds: reviewedIds }), /個別変更/);
    assert.equal(d.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n, before);
    assert.equal((await records()).exceptions.length, 2);
    const latest = await records();
    await actions.saveCalendarEvent({ eventId: created.operationId, scope: 'series', anchorDate: null, basisRevision: basis(latest),
      value: draft({ recurrence: 'biweekly' }), category, resetExceptions: true, expectedExceptionIds: latest.exceptions.flatMap(row => row.heads.map(op => op.operationId)) });
    assert.deepEqual((await records()).exceptions, []);
  } finally { d.connection.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} deleted shared series have no impossible exception-resolution controls`, () => {
    const head = { operationId: 'delete', payload: { value: null } };
    const model = { viewerUserId: 'owner', adminUserId: 'owner', calendar: [{ id: 'event', creatorUserId: 'owner', heads: [head],
      exceptions: [{ anchorDate: '2026-11-03', heads: [{ operationId: 'old-a' }, { operationId: 'old-b' }] }] }] };
    const screen = screenHarness('src/features/sharing/v2-ui/calendar-conflicts.tsx', { exportName: 'SharedCalendarConflicts', platform,
      props: { model, actions: {}, busy: false, run: async work => work() } });
    assert.equal(screen.text(), '');
  });
  test(`${platform} shared calendar conflict candidates expose differing location notes recurrence category and original time zone`, async () => {
    const head = (id, value, name, color) => ({ operationId: id, payload: { value, category: { ...category, name, color } } });
    const model = { viewerUserId: 'owner', adminUserId: 'owner', plan: { timeZone: 'Asia/Tokyo' }, calendar: [{ id: 'event', creatorUserId: 'owner', exceptions: [], heads: [
      head('a', draft({ location: 'Room A', notes: 'Bring the key', recurrence: 'weekly' }), '学校', '#348DC2'),
      head('b', draft({ location: 'Room B', notes: 'Bring the books', recurrence: 'biweekly', timeZone: 'UTC' }), '仕事', '#8459B3') ] }] };
    const screen = screenHarness('src/features/sharing/v2-ui/calendar-conflicts.tsx', { exportName: 'SharedCalendarConflicts', platform,
      props: { model, actions: {}, busy: false, run: async work => work() } });
    await screen.press('共有予定の変更確認（1件）を開く');
    for (const value of ['Room A', 'Room B', 'Bring the key', 'Bring the books', '毎週', '隔週', '学校', '仕事', 'UTC']) assert.ok(screen.text().includes(value), `missing conflict detail: ${value}`);
  });
}

for (const platform of ['ios', 'android']) test(`${platform} shared event reminders stay private and a failed local reminder save retries the committed shared intent without duplicating the event`, async () => {
  const f = await sharedEditorFixture(platform);
  const { readCalendarReminders, calendarReminderScope } = await import('../src/platform/storage/calendar-reminders.ts');
  const { sharedCalendarEventId } = await import('../src/features/calendar/shared-events.ts');
  try {
    const editor = await f.open(); const input = { ...f.input(), reminderMinutes: 60 };
    f.local.connection.exec("CREATE TRIGGER fail_reminder BEFORE INSERT ON calendar_notification_rules BEGIN SELECT RAISE(ABORT,'reminder write failed'); END");
    await assert.rejects(editor.binding.saveEvent(input, false), /reminder write failed/);
    assert.equal((await f.records()).length, 1);
    const saved = (await f.readDrafts()).drafts.find(row => row.audience === 'group'); assert.equal(saved.reminderMinutes, 60);
    f.local.connection.exec('DROP TRIGGER fail_reminder');
    await (await f.open()).binding.saveEvent(saved, false);
    const records = await f.records(); assert.equal(records.length, 1);
    assert.ok(!JSON.stringify(records[0].heads[0].payload).includes('reminderMinutes'));
    assert.deepEqual(f.d.connection.prepare('PRAGMA table_info(sharing_v2_calendar_intent_results)').all().map(row => row.name), ['intent_id', 'event_id']);
    const rules = (await readCalendarReminders(f.local.database)).rules;
    assert.equal(rules.length, 1); assert.deepEqual(rules[0], { scope: calendarReminderScope('owner', f.d.options.groupId), eventId: sharedCalendarEventId(f.d.options.groupId, records[0].id), anchorDate: null, minutes: 60 });
  } finally { f.close(); }
});
