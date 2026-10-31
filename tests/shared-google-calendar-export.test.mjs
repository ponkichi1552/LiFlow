import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedGoogleCalendarExport } from '../src/features/calendar/shared-google-export.ts';
import { GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

function fixture(count = 1) {
  let control = { enabled: false, revision: 0, subject: null, calendarId: null, retryCount: 0, retryAt: null }; let subject = 'google-user';
  const items = Array.from({ length: count }, (_, i) => ({ sourceId: `event-${i}`, revision: 'one', value: { ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: `共有${i}` } }));
  const links = new Map(); const remote = new Map(); const calls = []; let afterInsert = async () => {};
  const runtime = createSharedGoogleCalendarExport({ scope: { userId: 'owner', groupId: 'home' }, now: () => 1_000_000, random: () => .5,
    assertAccess: async () => {}, currentSubject: async () => subject, authorize: async () => ({ subject, label: '検査アカウント' }),
    store: {
      readControl: async () => ({ ...control }), configure: async (patch, revision) => { assert.equal(revision, control.revision); control = { ...control, ...patch, revision: revision + 1 }; return { ...control }; },
      saveStatus: async (revision, patch) => { if (revision === control.revision) control = { ...control, ...patch }; },
      readItems: async () => items, readLinks: async (sub, cal) => [...links.values()].filter(row => row.subject === sub && row.calendar === cal).map(row => row.value),
      saveLink: async (sub, cal, value) => { links.set(`${sub}:${cal}:${value.sourceId}`, { subject: sub, calendar: cal, value: { ...value } }); },
    }, createApi: context => ({
      calendars: async () => { await context.assertCurrent(); calls.push('calendars'); return { items: [{ id: 'cal', summary: '個人', accessRole: 'owner' }, { id: 'readonly', summary: '祝日', accessRole: 'reader' }] }; },
      insert: async (_cal, body) => { await context.assertCurrent(); calls.push('insert'); if (remote.has(body.id)) throw new GoogleCalendarHttpError(409);
        const row = { ...structuredClone(body), etag: 'etag1' }; remote.set(body.id, row); await afterInsert(); return structuredClone(row); },
      get: async (_cal, id) => { await context.assertCurrent(); calls.push('get'); if (!remote.has(id)) throw new GoogleCalendarHttpError(404); return structuredClone(remote.get(id)); },
      patch: async (_cal, id, body, etag) => { await context.assertCurrent(); calls.push('patch'); const old = remote.get(id); if (!old || old.etag !== etag) throw new GoogleCalendarHttpError(412);
        const row = { ...old, ...structuredClone(body), etag: old.etag + 'x' }; remote.set(id, row); return structuredClone(row); },
      remove: async (_cal, id, etag) => { await context.assertCurrent(); calls.push('delete'); if (remote.get(id)?.etag !== etag) throw new GoogleCalendarHttpError(412); remote.delete(id); },
    }),
  });
  const connect = async () => { const review = await runtime.prepareConnection(); assert.equal(review.calendars.length, 1); return runtime.connect(review, 'cal'); };
  return { runtime, items, calls, links, remote, connect, control: () => control, setSubject: value => { subject = value; }, afterInsert: work => { afterInsert = work; } };
}

test('shared Google export starts OFF and disabled synchronization performs no OAuth or Google operations', async () => {
  const f = fixture(); assert.equal((await f.runtime.readControl()).enabled, false);
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'skipped', sent: 0 }); assert.deepEqual(f.calls, []); assert.equal(f.links.size, 0);
  await assert.rejects(f.runtime.connect({ revision: 0, account: { subject: 'google-user' }, calendars: [] }, 'cal'));
});

test('shared Google export keeps links across OFF ON and sends at most 100 records in one pass', async () => {
  const f = fixture(150); await f.connect(); f.calls.length = 0;
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'pending', sent: 100 }); assert.equal(f.calls.length, 100); assert.equal(f.remote.size, 100);
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 50 }); assert.equal(f.remote.size, 150);
  const oldIds = [...f.remote.keys()]; await f.runtime.disable(f.control().revision); f.calls.length = 0;
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'skipped', sent: 0 }); assert.deepEqual(f.calls, []); assert.equal(f.remote.size, 150);
  await f.connect(); f.calls.length = 0; assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 0 }); assert.deepEqual(f.calls, []); assert.deepEqual([...f.remote.keys()], oldIds);
});

test('shared Google export retries a lost insert reply using the same ID and cannot duplicate the event', async () => {
  const f = fixture(); await f.connect(); f.afterInsert(async () => { throw new Error('通信が切断されました'); });
  assert.equal((await f.runtime.synchronize()).kind, 'error'); assert.equal(f.remote.size, 1); assert.equal(f.links.size, 0);
  f.afterInsert(async () => {}); assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind: 'success', sent: 1 }); assert.equal(f.remote.size, 1); assert.equal(f.links.size, 1);
});

test('Google edits cannot update the shared source and an etag conflict retains the unsent group update', async () => {
  const f = fixture(); await f.connect(); await f.runtime.synchronize(); const old = [...f.remote.values()][0]; old.summary = 'Googleだけの変更'; old.etag = 'changed';
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: 'グループの新しい内容' } };
  const result = await f.runtime.synchronize({ force: true }); assert.equal(result.kind, 'error'); assert.equal(f.items[0].value.title, 'グループの新しい内容');
  assert.equal([...f.remote.values()][0].summary, 'Googleだけの変更'); assert.equal([...f.links.values()][0].value.revision, 'one'); assert.match(f.control().error, /変更/u);
});

test('shared Google export rejects a changed native account and an altered calendar choice', async () => {
  const f = fixture(); const review = await f.runtime.prepareConnection();
  await assert.rejects(f.runtime.connect(review, 'readonly')); f.setSubject('another'); await assert.rejects(f.runtime.connect(review, 'cal')); assert.equal(f.control().enabled, false);
  f.setSubject('google-user'); await f.runtime.connect(review, 'cal'); f.setSubject('another'); f.calls.length = 0;
  assert.equal((await f.runtime.synchronize({ force: true })).kind, 'error'); assert.deepEqual(f.calls, []); assert.equal(f.remote.size, 0);
});
