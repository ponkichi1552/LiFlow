import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { newEventDraft } = await import('../src/features/calendar/events.ts');
const { createEditorDraftSession } = await import('../src/features/calendar/editor-draft-session.ts');
const { saveCalendarDraft, readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const draft = (audience, title) => ({ eventId: null, revision: 0, exceptionRevision: 0, scope: 'series', anchorDate: null,
  audience, ...(audience === 'group' ? { groupId: 'group' } : {}), value: { ...newEventDraft('2026-11-14', 'Asia/Tokyo'), title } });
test('one editor cleans its saved destination snapshots without clearing newer or unrelated input', async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await initializeLocalDatabase(db.database);
  const session = createEditorDraftSession(); const personal = draft('personal', '個人の入力'); const shared = draft('group', '共有の入力');
  await saveCalendarDraft(db.database, personal); session.remember(personal);
  await saveCalendarDraft(db.database, shared); session.remember(shared);
  const newer = draft('personal', '別の画面の新しい入力'); await saveCalendarDraft(db.database, newer);
  await session.clear(db.database);
  assert.deepEqual((await readLocalCalendar(db.database)).drafts.map(row => row.value.title), [newer.value.title]);
});
test('saving the current destination leaves one draft and clearing a chore removes both owned snapshots', async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await initializeLocalDatabase(db.database);
  const session = createEditorDraftSession(); const personal = draft('personal', '入力'); const shared = draft('group', '入力');
  for (const item of [personal, shared]) { await saveCalendarDraft(db.database, item); session.remember(item); }
  await session.clear(db.database, shared);
  assert.deepEqual((await readLocalCalendar(db.database)).drafts.map(row => row.audience), ['group']);
  await session.clear(db.database); assert.equal((await readLocalCalendar(db.database)).drafts.length, 0);
});
