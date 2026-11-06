import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2CalendarActions } from '../src/features/sharing/v2/calendar-actions.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarDraft } = await import('../src/platform/storage/calendar-events.ts');

const category = { id: 'personal', name: '私用', color: '#348DC2', revision: 1 };
const draft = extra => ({ ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: 'Shared event', recurrence: 'weekly', ...extra });
const basis = record => JSON.stringify([record.heads.map(op => op.operationId).sort(), record.heads.map(op => op.operationId).sort()]);

async function sharedEditorFixture(platform) {
  const f = await fixture(); const d = await f.device(); const local = createDatabase(); let ordinal = 0;
  await d.repository.commit(seeds()); await initializeLocalDatabase(local.database);
  const actions = createV2CalendarActions(d.repository, () => `durable-calendar-${++ordinal}`);
  const records = async () => readSharedCalendar((await d.repository.readState()).assessment.view);
  const open = async (overrides = {}) => {
    let binding;
    const model = { viewerUserId: 'owner', adminUserId: 'owner', calendarSupported: true,
      plan: { groupId: d.options.groupId }, calendar: await records() };
    const props = { local: { database: local.database, snapshot: await readLocalCalendar(local.database), refresh: async () => {}, error: null, loading: false },
      model, actions, perform: async work => {
        try { await work(); return { committed: true, refreshed: true }; }
        catch (error) { return { committed: false, refreshed: false, error }; }
      }, capture: value => { binding = value; }, ...overrides };
    const screen = screenHarness('tests/helpers/calendar-source-host.tsx', { exportName: 'CalendarSourceHost', platform, props });
    return { get binding() { screen.render(); return binding; }, props, screen };
  };
  const input = () => ({ audience: 'group', groupId: d.options.groupId, eventId: null, anchorDate: null,
    revision: 0, exceptionRevision: 0, scope: 'series', value: draft() });
  return { ...f, d, local, actions, records, open, input, close() { d.connection.close(); local.connection.close(); } };
}

for (const platform of ['ios', 'android']) {
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
      const restored = (await readLocalCalendar(f.local.database)).draft; assert.ok(restored.submission);
      const restarted = await f.open(); failCleanup = false;
      await restarted.binding.saveEvent(restored, false);
      assert.equal((await f.records()).length, 1);
      assert.equal(f.d.connection.prepare('SELECT count(*) AS n FROM sharing_v2_mutation_intents').get().n, 1);
      assert.equal((await readLocalCalendar(f.local.database)).draft, null);
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
        await saveCalendarDraft(f.local.database, newer); return result;
      } } });
      await editor.binding.saveEvent(f.input(), false);
      assert.equal((await f.records()).length, 1);
      assert.deepEqual((await readLocalCalendar(f.local.database)).draft, newer);
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
      assert.equal((await f.records()).length, 0); assert.ok((await readLocalCalendar(f.local.database)).draft);
      before = false;
      await assert.rejects(editor.binding.saveEvent(input, false), /reply lost/);
      assert.equal((await f.records()).length, 1);
      lostReply = false;
      await editor.binding.saveEvent(input, false);
      assert.equal((await f.records()).length, 1, 'an edited restored draft must reuse the current attempt instead of its obsolete submission');
      // Closing after recovery must persist the current submission, not the
      // obsolete identity that came with the original restored draft.
      await editor.binding.persistDraft(input);
      const restored = (await readLocalCalendar(f.local.database)).draft;
      await (await f.open()).binding.saveEvent(restored, false);
      assert.equal((await f.records()).length, 1); assert.equal((await readLocalCalendar(f.local.database)).draft, null);
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
      const restored = (await readLocalCalendar(f.local.database)).draft;
      failCleanup = false; editor = await f.open(); await editor.binding.saveEvent(restored, false);
      let record = (await f.records())[0]; assert.equal(record.heads[0].payload.value.title, 'Edited shared event');
      assert.equal((await f.d.repository.readState()).replica.operations.filter(row => row.entityType === 'calendarEvent').length, 2);
      editor = await f.open(); const updated = editor.binding.snapshot.events.find(row => row.id === event.id);
      const remove = editor.binding.prepareDraft({ ...f.input(), audience: undefined, groupId: undefined, eventId: updated.id,
        revision: updated.revision, value: updated });
      failCleanup = true; await editor.binding.deleteEvent(remove);
      const retryDelete = (await readLocalCalendar(f.local.database)).draft;
      failCleanup = false; editor = await f.open(); await editor.binding.deleteEvent(retryDelete);
      record = (await f.records())[0]; assert.equal(record.heads[0].payload.value, null);
      assert.equal((await f.d.repository.readState()).replica.operations.filter(row => row.entityType === 'calendarEvent').length, 3);
      assert.equal((await readLocalCalendar(f.local.database)).draft, null);
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
