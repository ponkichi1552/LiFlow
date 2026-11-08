import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedGoogleCalendarExport } from '../src/features/calendar/shared-google-export.ts';
import { GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { GoogleAccountMismatchError } from '../src/features/google-sync/account-binding.ts';
import { googleOwnedFields } from '../src/features/calendar/google-owned-fields.ts';

function fixture(count = 1, options = {}) {
  let control = { enabled: false, revision: 0, subject: null, calendarId: null, retryCount: 0, retryAt: null }; let subject = 'google-user';
  const items = Array.from({ length: count }, (_, i) => ({ sourceId: `event-${i}`, revision: 'one', value: { ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: `共有${i}` } }));
  const links = new Map(); const remote = new Map(); const calls = []; let afterInsert = async () => {};
  const runtimeInput = { scope: { userId: 'owner', groupId: 'home' }, now: () => 1_000_000, random: () => .5,
    assertAccess: async () => {}, currentSubject: async () => subject, authorize: async expected => {
      await options.authorize?.(); if (expected && subject !== expected) throw new GoogleAccountMismatchError(); return { subject, label: '検査アカウント' };
    },
    store: {
      readControl: async () => ({ ...control }), configure: async (patch, revision) => { assert.equal(revision, control.revision); control = { ...control, ...patch, revision: revision + 1 }; return { ...control }; },
      saveStatus: async (revision, patch) => { if (revision === control.revision) control = { ...control, ...patch }; },
      readItems: async () => { await options.readItems?.(); return items; }, readLinks: async (sub, cal) => [...links.values()].filter(row => row.subject === sub && row.calendar === cal).map(row => row.value),
      saveLink: async (sub, cal, value) => { links.set(`${sub}:${cal}:${value.sourceId}`, { subject: sub, calendar: cal, value: { ...value } }); },
      ...options.store,
    }, createApi: context => ({
      calendars: async () => { await context.assertCurrent(); calls.push('calendars'); return { items: options.calendars ?? [{ id: 'cal', summary: '個人', accessRole: 'owner' }, { id: 'readonly', summary: '祝日', accessRole: 'reader' }] }; },
      insert: async (_cal, body) => { await context.assertCurrent(); calls.push('insert'); if (remote.has(body.id)) throw new GoogleCalendarHttpError(409);
        const row = { ...structuredClone(body), etag: 'etag1' }; remote.set(body.id, row); await afterInsert(); return structuredClone(row); },
      get: async (_cal, id) => { await context.assertCurrent(); calls.push('get'); if (!remote.has(id)) throw new GoogleCalendarHttpError(404); return structuredClone(remote.get(id)); },
      patch: async (_cal, id, body, etag) => { await context.assertCurrent(); calls.push('patch'); const old = remote.get(id); if (!old || old.etag !== etag) throw new GoogleCalendarHttpError(412);
        const row = { ...old, ...structuredClone(body), etag: old.etag + 'x' }; remote.set(id, row); await options.afterPatch?.(row); return structuredClone(row); },
      remove: async (_cal, id, etag) => { await context.assertCurrent(); calls.push('delete'); if (remote.get(id)?.etag !== etag) throw new GoogleCalendarHttpError(412);
        if (options.tombstones) { const old = remote.get(id); remote.set(id, { id, status: 'cancelled', etag: old.etag + '-deleted', recurringEventId: old.recurringEventId, originalStartTime: old.originalStartTime }); }
        else remote.delete(id); },
      instances: async (_cal, id, range) => { await context.assertCurrent(); calls.push('instances'); return options.instances?.({ id, range, remote }) ?? { items: [] }; },
    }),
  };
  const runtime = createSharedGoogleCalendarExport(runtimeInput);
  const connect = async () => { const review = await runtime.prepareConnection(); assert.equal(review.calendars.length, 1); return runtime.connect(review, 'cal'); };
  return { runtime, restart: () => createSharedGoogleCalendarExport(runtimeInput), items, calls, links, remote, connect, control: () => control, setSubject: value => { subject = value; }, afterInsert: work => { afterInsert = work; } };
}

test('a second installation with an old Google ETag can advance a verified intermediate shared revision without creating another event', async () => {
  const known = new Map(); let currentRevision = 'one';
  const f = fixture(1, { store: { knownSeriesRevision: async (source, revision) => source === 'event-0' && known.has(revision)
    ? { currentRevision, fields: known.get(revision) } : null } });
  await f.connect(); await f.runtime.synchronize(); const [id] = f.remote.keys(); const key = [...f.links.keys()][0];
  const first = structuredClone(f.links.get(key)); known.set('one', googleOwnedFields(f.remote.get(id)));
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '別端末の版2' } }; currentRevision = 'two';
  await f.runtime.synchronize(); known.set('two', googleOwnedFields(f.remote.get(id)));
  f.links.set(key, first);
  f.items[0] = { ...f.items[0], revision: 'three', value: { ...f.items[0].value, title: '現在の版3' } }; currentRevision = 'three'; f.calls.length = 0;
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 1 });
  assert.equal(f.remote.size, 1); assert.equal(f.remote.get(id).summary, '現在の版3');
  assert.deepEqual(f.calls, ['patch', 'get', 'patch']); assert.equal(f.links.get(key).value.pending, undefined);
  assert.equal(f.links.get(key).value.revision, 'three');
});

test('an older pending shared export never rolls a verified newer Google copy back before adopting its receipt', async () => {
  const known = new Map(); let currentRevision = 'one';
  const f = fixture(1, { store: { knownSeriesRevision: async (_source, revision) => known.has(revision) ? { currentRevision, fields: known.get(revision) } : null } });
  await f.connect(); await f.runtime.synchronize(); const [id] = f.remote.keys(); const key = [...f.links.keys()][0]; const old = structuredClone(f.links.get(key));
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '版2' } }; currentRevision = 'two'; await f.runtime.synchronize(); const second = structuredClone(f.remote.get(id));
  f.items[0] = { ...f.items[0], revision: 'three', value: { ...f.items[0].value, title: '版3' } }; currentRevision = 'three'; await f.runtime.synchronize();
  known.set('three', googleOwnedFields(f.remote.get(id))); const etag = f.remote.get(id).etag;
  f.links.set(key, { ...old, value: { ...old.value, pending: { method: 'patch', googleId: id, etag: old.value.etag, revision: 'two', payload: second } } });
  f.calls.length = 0; assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 1 });
  assert.equal(f.remote.get(id).summary, '版3'); assert.equal(f.remote.get(id).etag, etag); assert.deepEqual(f.calls, ['patch', 'get']);
  assert.equal(f.links.get(key).value.revision, 'three'); assert.equal(f.links.get(key).value.pending, undefined);
});

test('a rebased shared export survives a lost successful PATCH reply and recovers the exact new ETag without repeating the change', async () => {
  const known = new Map(); let currentRevision = 'one'; let lose = false;
  const f = fixture(1, { store: { knownSeriesRevision: async (_source, revision) => known.has(revision) ? { currentRevision, fields: known.get(revision) } : null },
    afterPatch: async () => { if (lose) { lose = false; throw new TypeError('lost rebased reply'); } } });
  await f.connect(); await f.runtime.synchronize(); const [id] = f.remote.keys(); const key = [...f.links.keys()][0]; const first = structuredClone(f.links.get(key));
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '版2' } }; currentRevision = 'two'; await f.runtime.synchronize();
  known.set('two', googleOwnedFields(f.remote.get(id))); f.links.set(key, first);
  f.items[0] = { ...f.items[0], revision: 'three', value: { ...f.items[0].value, title: '版3' } }; currentRevision = 'three'; lose = true;
  assert.equal((await f.runtime.synchronize()).kind, 'error'); const committed = structuredClone(f.remote.get(id));
  assert.equal(f.links.get(key).value.pending.revision, 'three'); assert.equal(f.links.get(key).value.pending.method, 'patch');
  assert.equal((await f.restart().synchronize({ force: true })).kind, 'success');
  assert.deepEqual(f.remote.get(id), committed); assert.equal(f.links.get(key).value.etag, committed.etag); assert.equal(f.remote.size, 1);
});

test('a newer shared source found during conflict recovery defers its stale captured payload and resumes from the new source', async () => {
  const known = new Map(); let currentRevision = 'one';
  const f = fixture(1, { store: { knownSeriesRevision: async (_source, revision) => known.has(revision) ? { currentRevision, fields: known.get(revision) } : null } });
  await f.connect(); await f.runtime.synchronize(); const [id] = f.remote.keys(); const key = [...f.links.keys()][0]; const first = structuredClone(f.links.get(key));
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '版2' } }; currentRevision = 'two'; await f.runtime.synchronize();
  known.set('two', googleOwnedFields(f.remote.get(id))); f.links.set(key, first); const second = structuredClone(f.remote.get(id));
  f.items[0] = { ...f.items[0], revision: 'three', value: { ...f.items[0].value, title: '古い表示の版3' } }; currentRevision = 'four';
  assert.equal((await f.runtime.synchronize()).kind, 'pending'); assert.deepEqual(f.remote.get(id), second);
  f.items[0] = { ...f.items[0], revision: 'four', value: { ...f.items[0].value, title: '最新の版4' } };
  assert.equal((await f.runtime.synchronize()).kind, 'success'); assert.equal(f.remote.get(id).summary, '最新の版4');
});

test('a stale shared delete can rebase only a verified prior LiFlow series before using the new conditional ETag', async () => {
  const known = new Map(); let currentRevision = 'one';
  const f = fixture(1, { store: { knownSeriesRevision: async (_source, revision) => known.has(revision) ? { currentRevision, fields: known.get(revision) } : null } });
  await f.connect(); await f.runtime.synchronize(); const [id] = f.remote.keys(); const key = [...f.links.keys()][0]; const first = structuredClone(f.links.get(key));
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '版2' } }; currentRevision = 'two'; await f.runtime.synchronize();
  known.set('two', googleOwnedFields(f.remote.get(id))); f.links.set(key, first);
  f.items[0] = { ...f.items[0], revision: 'deleted', value: null }; currentRevision = 'deleted'; f.calls.length = 0;
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 1 }); assert.equal(f.remote.size, 0);
  assert.deepEqual(f.calls, ['delete', 'get', 'delete']); assert.equal(f.links.get(key).value.deleted, true);
});

test('an unverified Google edit stays pending while independent shared calendar changes still export', async () => {
  const f = fixture(2, { store: { knownSeriesRevision: async () => ({ currentRevision: 'two', fields: 'forged-proof-does-not-match-the-received-body' }) } });
  await f.connect(); await f.runtime.synchronize();
  const first = [...f.remote.values()].find(row => row.summary === '共有0'); first.summary = 'Googleだけで編集した内容'; first.etag += '-manual';
  for (let index = 0; index < 2; index++) f.items[index] = { ...f.items[index], revision: 'two', value: { ...f.items[index].value, title: `共有版2-${index}` } };
  f.calls.length = 0; assert.deepEqual(await f.runtime.synchronize(), { kind: 'error', sent: 1 });
  assert.equal(f.remote.get(first.id).summary, 'Googleだけで編集した内容');
  assert.ok([...f.remote.values()].some(row => row.summary === '共有版2-1'));
  assert.ok([...f.links.values()].find(row => row.value.sourceId === 'event-0').value.pending);
  assert.equal([...f.links.values()].find(row => row.value.sourceId === 'event-1').value.revision, 'two');
});

test('shared Google export starts OFF and disabled synchronization performs no OAuth or Google operations', async () => {
  const f = fixture(); assert.equal((await f.runtime.readControl()).enabled, false);
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'skipped', sent: 0 }); assert.deepEqual(f.calls, []); assert.equal(f.links.size, 0);
  await assert.rejects(f.runtime.connect({ revision: 0, account: { subject: 'google-user' }, calendars: [] }, 'cal'));
});

test('shared Calendar account reconnection is explicit and reviewed while OFF ON background work and old Google links stay account-bound', async () => {
  const f = fixture(); await f.connect(); await f.runtime.synchronize(); const originalIds = [...f.remote.keys()];
  await f.runtime.disable(f.control().revision); f.setSubject('new-google-user'); f.calls.length = 0;
  await assert.rejects(f.runtime.prepareConnection(), GoogleAccountMismatchError);
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'skipped', sent: 0 }); assert.deepEqual(f.calls, []);
  const discarded = await f.runtime.prepareConnection({ replaceAccount: true });
  assert.equal(discarded.account.subject, 'new-google-user'); assert.equal(f.control().subject, 'google-user'); assert.equal(f.control().enabled, false);
  f.setSubject('third-google-user'); await assert.rejects(f.runtime.connect(discarded, 'cal'), GoogleAccountMismatchError);
  f.setSubject('new-google-user'); const review = await f.runtime.prepareConnection({ replaceAccount: true });
  await f.runtime.connect(review, 'cal'); assert.equal(f.control().subject, 'new-google-user');
  assert.equal((await f.runtime.synchronize()).sent, 1); assert.equal(f.links.size, 2); assert.ok(f.remote.has(originalIds[0]));
  f.setSubject('google-user'); const returning = await f.runtime.prepareConnection({ replaceAccount: true }); await f.runtime.connect(returning, 'cal');
  f.calls.length = 0; assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 0 }); assert.deepEqual(f.calls, []);
  assert.equal(f.links.size, 2); assert.equal(f.remote.size, 2);
});

test('shared Google export reports pending for conflicted or unreceipted sources without deleting their prior copies or blocking independent changes', async () => {
  for (const blocked of ['receipt', 'conflict']) {
    const f = fixture(2); await f.connect(); await f.runtime.synchronize();
    const original = structuredClone(f.items[0]); const copy = [...f.remote.values()].find(row => row.summary === original.value.title);
    f.control().lastSyncAt = 12345;
    f.items[0] = { ...original, revision: 'blocked-revision', value: null, blocked };
    f.items[1] = { ...f.items[1], revision: 'two', value: { ...f.items[1].value, title: '独立した変更' } }; f.calls.length = 0;
    assert.deepEqual(await f.runtime.synchronize(), { kind: 'pending', sent: 1 });
    assert.deepEqual(f.calls, ['patch']); assert.deepEqual(f.remote.get(copy.id), copy);
    assert.equal(f.control().pending, true); assert.equal(f.control().lastSyncAt, 12345);
    f.calls.length = 0; assert.deepEqual(await f.runtime.synchronize(), { kind: 'pending', sent: 0 }); assert.deepEqual(f.calls, []);
    f.items[0] = { ...original, revision: 'resolved', value: { ...original.value, title: '確定した内容' } };
    assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 1 }); assert.equal(f.control().pending, false);
    assert.equal(f.remote.get(copy.id).summary, '確定した内容'); assert.equal(f.remote.size, 2);
  }
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
  assert.equal((await f.runtime.synchronize()).kind, 'error'); assert.equal(f.remote.size, 1); assert.equal(f.links.size, 1);
  assert.ok([...f.links.values()][0].value.pending, 'the sent request is durable before HTTP');
  assert.equal([...f.links.values()][0].value.revision, '', 'unconfirmed output is not acknowledged');
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

test('shared Calendar retries normalized Google responses after lost insert and patch acknowledgements without duplicates', async () => {
  for (const allDay of [false, true]) {
    const f = fixture(); f.items[0].value.allDay = allDay; await f.connect();
    const normalize = row => { delete row.location; delete row.description; delete row.transparency; if (!row.recurrence?.length) delete row.recurrence; };
    f.afterInsert(async () => { normalize([...f.remote.values()][0]); throw new TypeError('lost acknowledgement'); });
    assert.equal((await f.runtime.synchronize()).kind, 'error'); assert.equal(f.remote.size, 1);
    f.afterInsert(async () => {});
    assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind: 'success', sent: 1 });
    assert.equal(f.remote.size, 1); assert.equal(f.links.size, 1);
    f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '更新後' } };
    const row = [...f.remote.values()][0]; row.summary = '更新後'; row.etag += '-already-patched';
    assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind: 'success', sent: 1 });
    assert.equal(f.remote.size, 1);
    row.summary = '別の利用者による変更'; row.etag += '-other';
    f.items[0] = { ...f.items[0], revision: 'three', value: { ...f.items[0].value, title: '確認が必要な編集' } };
    assert.equal((await f.runtime.synchronize({ force: true })).kind, 'error');
    assert.equal(row.summary, '別の利用者による変更');
  }
});

test('explicit Google consent has its own human interaction time before the bounded calendar-list request', async () => {
  const original = Date.now; let clock = original(); Date.now = () => clock;
  try {
    const f = fixture(0, { authorize: async () => { clock += 60_000; } });
    await f.connect(); assert.equal(f.control().enabled, true);
  } finally { Date.now = original; }
});

test('a recurring instance moved to another timezone is matched using its original series civil date', async () => {
  const f = fixture(1, { instances: ({ id, remote }) => {
    const row = { id: id + '_instance', etag: 'instance', recurringEventId: id, originalStartTime: { dateTime: '2026-10-31T15:30:00Z', timeZone: 'Asia/Tokyo' } };
    remote.set(row.id, row); return { items: [row] };
  } });
  f.items[0].value = { ...f.items[0].value, startDate: '2026-11-01', endDate: '2026-11-01', recurrence: 'weekly', startMinute: 30, endMinute: 90 };
  f.items.push({ sourceId: 'changed-instance', parentId: 'event-0', anchorDate: '2026-11-01', revision: 'exception', value: {
    ...f.items[0].value, recurrence: 'none', timeZone: 'America/Los_Angeles', startDate: '2026-11-03', endDate: '2026-11-03', startMinute: 600, endMinute: 660,
  } });
  await f.connect(); assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 2 });
  assert.equal([...f.remote.values()].find(row => row.recurringEventId)?.start.timeZone, 'America/Los_Angeles');
});

test('a short joining shared-export worker shortens the existing pass and aborts HTTP without dropping pending changes', async () => {
  let started; const began = new Promise(resolve => { started = resolve; });
  let control = { enabled: true, revision: 1, subject: 'synthetic', calendarId: 'calendar', retryCount: 0, retryAt: null };
  const runtime = createSharedGoogleCalendarExport({ scope: { userId: 'owner', groupId: 'group' },
    assertAccess: async () => {}, currentSubject: async () => 'synthetic', authorize: async () => ({ subject: 'synthetic', label: 'test' }),
    store: { readControl: async () => control, readItems: async () => [{ sourceId: 'event', revision: 'one', value: { ...newEventDraft('2026-11-01', 'UTC'), title: 'Synthetic' } }],
      readLinks: async () => [], saveStatus: async (_revision, patch) => { control = { ...control, ...patch }; }, saveLink: async (_subject, _calendar, link) => { assert.ok(link.pending, 'an aborted request is not acknowledged'); } },
    createApi: ({ signal }) => ({ insert: async () => { started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('budget'), { name: 'AbortError' })), { once: true })); } }),
  });
  const original = runtime.synchronize(); await began;
  assert.equal(runtime.synchronize({ budgetMs: 10 }), original);
  assert.deepEqual(await original, { kind: 'pending', sent: 0 }); assert.equal(control.pending, true);
});

test('explicit manual Calendar sync gets a separate bounded foreground budget without extending automatic workers', async () => {
  const original = Date.now; let clock = original(); Date.now = () => clock;
  try {
    const f = fixture(150, { readItems: async () => { clock += 30_000; } }); await f.connect();
    assert.deepEqual(await f.runtime.synchronize({ force: true, budgetMs: 90_000 }), { kind: 'pending', sent: 0 }, 'force alone cannot extend a worker');
    assert.deepEqual(await f.runtime.synchronize({ force: true, interactive: true }), { kind: 'pending', sent: 100 });
    assert.deepEqual(await f.runtime.synchronize({ force: true, interactive: true }), { kind: 'success', sent: 50 });
    assert.equal(f.remote.size, 150, 'the longer user pass keeps the 100-request limit and the same event identities');
    f.items[0] = { ...f.items[0], revision: 'second', value: { ...f.items[0].value, title: 'Manual update' } };
    assert.deepEqual(await f.runtime.synchronize({ interactive: true, budgetMs: 10_000 }), { kind: 'pending', sent: 0 }, 'an explicit shorter deadline remains authoritative');
  } finally { Date.now = original; }
});

test('a manual Calendar request behind a running worker starts its own fresh pass without extending that worker', async () => {
  const original = Date.now; let clock = original(); Date.now = () => clock;
  let release; let began; const started = new Promise(resolve => { began = resolve; }); const held = new Promise(resolve => { release = resolve; }); let reads = 0;
  try {
    const f = fixture(1, { readItems: async () => { if (++reads === 1) { began(); await held; } clock += 30_000; } }); await f.connect();
    const worker = f.runtime.synchronize(); await started;
    const manual = f.runtime.synchronize({ force: true, interactive: true }); release();
    assert.deepEqual(await worker, { kind: 'pending', sent: 0 });
    assert.deepEqual(await manual, { kind: 'success', sent: 1 }); assert.equal(reads, 2); assert.equal(f.remote.size, 1);
  } finally { release(); Date.now = original; }
});

test('another installation can recover the same updated Google event from its current source proof without creating a copy', async () => {
  const f = fixture(); await f.connect(); await f.runtime.synchronize();
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '共有の更新後' } };
  await f.runtime.synchronize({ force: true }); f.links.clear();
  assert.deepEqual(await f.runtime.synchronize({ force: true }), { kind: 'success', sent: 1 });
  assert.equal(f.remote.size, 1); assert.equal(f.links.size, 1);
  const row = [...f.remote.values()][0]; row.status = 'cancelled'; f.links.clear();
  assert.equal((await f.runtime.synchronize({ force: true })).kind, 'error', 'a cancelled event is not a successful acknowledgement');
});

test('a finite custom rule without any matching dates creates no phantom Google event', async () => {
  const f = fixture(); f.items[0].value = { ...f.items[0].value, startDate: '2028-11-01', endDate: '2028-11-01',
    recurrence: 'custom', customRecurrence: { unit: 'week', interval: 2, weekdays: [1, 4] }, untilDate: '2028-11-01' };
  await f.connect(); f.calls.length = 0;
  assert.deepEqual(await f.runtime.synchronize(), { kind: 'success', sent: 1 }); assert.equal(f.remote.size, 0); assert.deepEqual(f.calls, []);
});

for (const platform of ['ios', 'android']) test(`${platform} shared Calendar settings request an interactive budget only after a user action and keep disabled mode inert`, async () => {
  const { screenHarness } = await import('./helpers/screen-harness.mjs');
  let control = { enabled: true, revision: 1, subject: 'synthetic', calendarId: 'calendar', pending: false, lastSyncAt: null };
  const calls = []; const review = { account: { subject: 'synthetic', label: 'Synthetic' }, calendars: [{ id: 'calendar', summary: 'QA Calendar' }] };
  const runtime = { readControl: async () => ({ ...control }), synchronize: async options => { calls.push(['sync', options]); },
    disable: async revision => { assert.equal(revision, control.revision); calls.push(['off']); control = { ...control, enabled: false, revision: revision + 1 }; },
    prepareConnection: async options => { calls.push(['prepare', options]); return review; }, connect: async (current, id) => { assert.equal(current, review); assert.equal(id, 'calendar'); calls.push(['connect']); control = { ...control, enabled: true, revision: control.revision + 1 }; } };
  const screen = screenHarness('src/features/calendar/shared-google-settings.tsx', { exportName: 'SharedGoogleCalendarSettings', platform, effectDependencies: true, effect: callback => callback(), props: { runtime, onBack() {} } });
  try {
    await screen.flush(); assert.deepEqual(calls, [], 'mounting never authorizes or synchronizes Google');
    await screen.press('今すぐ追加・更新'); await screen.flush();
    assert.deepEqual(calls, [['sync', { force: true, interactive: true }]]);
    const toggle = () => screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '共有予定をGoogleカレンダーに追加');
    toggle().props.onPress(); await screen.flush(); await screen.flush();
    assert.equal(toggle().props.accessibilityState.checked, false); assert.deepEqual(calls.at(-1), ['off']);
    await screen.press('接続先を変更'); await screen.flush(); assert.deepEqual(calls.at(-1), ['prepare', { replaceAccount: true }]);
    await screen.press('キャンセル'); await screen.flush(); assert.equal(toggle().props.accessibilityState.checked, false);
    toggle().props.onPress(); await screen.flush(); await screen.flush();
    assert.deepEqual(calls.at(-1), ['prepare', { replaceAccount: false }]); await screen.press('QA Calendar'); await screen.flush();
    assert.deepEqual(calls.slice(-2), [['connect'], ['sync', { force: true, interactive: true }]]);
    assert.equal(toggle().props.accessibilityState.checked, true);
  } finally { screen.unmount(); }
});

for (const method of ['insert', 'patch']) for (const action of ['edit', 'delete']) test(`shared Google export durably recovers a lost ${method} before a later ${action}`, async t => {
  const { fixture: repositoryFixture, seeds } = await import('./helpers/sharing-v2-repository-fixture.mjs');
  const { createSharedCalendarExportStore } = await import('../src/platform/storage/sharing-v2-calendar-export.ts');
  const d = await (await repositoryFixture()).device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const store = createSharedCalendarExportStore(d.repository); let losePatch = false;
  const f = fixture(1, { store: { readLinks: store.readLinks, saveLink: store.saveLink }, afterPatch: async () => {
    if (losePatch) { losePatch = false; throw new Error('lost response'); }
  } });
  await f.connect();
  if (method === 'patch') {
    await f.runtime.synchronize(); f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: '送信した変更' } }; losePatch = true;
  } else f.afterInsert(async () => { throw new Error('lost response'); });
  assert.equal((await f.runtime.synchronize({ force: true })).kind, 'error');
  assert.ok((await store.readLinks('google-user', 'cal'))[0].pending);
  f.items[0] = { ...f.items[0], revision: 'three', value: action === 'delete' ? null : { ...f.items[0].value, title: '応答喪失後の変更' } };
  f.afterInsert(async () => {});
  assert.equal((await f.restart().synchronize({ force: true })).kind, 'success');
  assert.equal(f.remote.size, action === 'delete' ? 0 : 1);
  if (action === 'edit') assert.equal([...f.remote.values()][0].summary, '応答喪失後の変更');
  const [accepted] = await store.readLinks('google-user', 'cal'); assert.equal(accepted.revision, 'three'); assert.equal(accepted.pending, undefined);
});

test('a moved recurring Google copy is found by original start and later edits use its stable id', async () => {
  let lookups = 0;
  const f = fixture(1, { instances: ({ id, range, remote }) => {
    lookups++; assert.equal(range.timeMin, undefined); assert.ok(range.originalStart?.startsWith('2026-11-07'));
    const row = { id: 'moved-instance', etag: 'initial', recurringEventId: id, originalStartTime: { dateTime: '2026-11-07T00:00:00+09:00' }, start: { dateTime: '2030-01-01T09:00:00+09:00' } };
    remote.set(row.id, row); return { items: [row] };
  } });
  f.items[0].value = { ...f.items[0].value, recurrence: 'weekly' };
  f.items.push({ sourceId: 'event-0:2026-11-07', parentId: 'event-0', anchorDate: '2026-11-07', revision: 'exception', value: { ...f.items[0].value,
    recurrence: 'none', startDate: '2031-01-01', endDate: '2031-01-01', title: '遠方へ変更' } });
  await f.connect(); assert.equal((await f.runtime.synchronize()).kind, 'success');
  f.items[1] = { ...f.items[1], revision: 'again', value: { ...f.items[1].value, title: '再編集' } };
  assert.equal((await f.runtime.synchronize()).kind, 'success'); assert.equal(lookups, 1);
  assert.equal(f.remote.get('moved-instance').summary, '再編集');
  f.items[1] = { ...f.items[1], revision: 'delete', value: null }; await f.runtime.synchronize(); assert.equal(f.remote.has('moved-instance'), false);
});

test('shared Calendar accepts permitted writerWithoutPrivateAccess targets without changing visibility', async () => {
  const f = fixture(1, { calendars: [{ id: 'cal', summary: '書込み可能', accessRole: 'writerWithoutPrivateAccess' }] });
  await f.connect(); assert.equal((await f.runtime.synchronize()).kind, 'success');
  assert.equal([...f.remote.values()][0].visibility, undefined);
});

for (const externalEdit of [false, true]) test(`restoring a deleted recurring copy ${externalEdit ? 'preserves a later external edit' : 'uses the verified current tombstone ETag'}`, async () => {
  const f = fixture(1, { tombstones: true, instances: ({ id, remote }) => {
    const row = { id: 'instance', recurringEventId: id, originalStartTime: { date: '2026-11-07' }, etag: 'before-delete' }; remote.set(row.id, row); return { items: [row] };
  } });
  f.items[0].value = { ...f.items[0].value, allDay: true, recurrence: 'weekly' };
  f.items.push({ sourceId: 'exception', parentId: 'event-0', anchorDate: '2026-11-07', value: { ...f.items[0].value,
    recurrence: 'none', startDate: '2026-11-07', endDate: '2026-11-07' }, revision: 'one' });
  await f.connect(); assert.equal((await f.runtime.synchronize()).kind, 'success');
  f.items[1] = { ...f.items[1], revision: 'deleted', value: null }; assert.equal((await f.runtime.synchronize()).kind, 'success');
  assert.equal(f.remote.get('instance').status, 'cancelled');
  if (externalEdit) Object.assign(f.remote.get('instance'), { status: 'confirmed', summary: 'Google側の復元', etag: 'other' });
  f.items[1] = { ...f.items[1], revision: 'reset', reset: true, value: f.items[0].value };
  assert.equal((await f.runtime.synchronize()).kind, externalEdit ? 'error' : 'success');
  assert.equal(f.remote.get('instance').summary, externalEdit ? 'Google側の復元' : '共有0');
});

test('a stalled native identity check cannot hold shared Calendar export beyond its background deadline',async t=>{
  let armed=false,release;const never=new Promise(resolve=>{release=resolve;});
  const control={enabled:true,revision:1,subject:'google-user',calendarId:'cal',retryAt:null,retryCount:0};
  const runtime=createSharedGoogleCalendarExport({scope:{userId:'owner',groupId:'home'},assertAccess:async()=>{},
    currentSubject:()=>armed?never:Promise.resolve('google-user'),authorize:async()=>({subject:'google-user',label:'QA'}),
    store:{readControl:async()=>control,readItems:async()=>[],readLinks:async()=>[],saveStatus:async()=>{},saveLink:async()=>{}},createApi:()=>({})});
  t.mock.timers.enable({apis:['setTimeout']});armed=true;let result;
  const pending=runtime.synchronize({budgetMs:1000}).then(value=>result=value);
  try {
    for(let i=0;i<20;i++)await new Promise(setImmediate);
    t.mock.timers.tick(1000);for(let i=0;i<20;i++)await new Promise(setImmediate);
    assert.equal(result?.kind,'pending');assert.equal(result.sent,0);
  } finally {release('google-user');await pending;t.mock.timers.reset();}
});

test('a changed shared event requested during an export receives one trailing pass without waiting for the next periodic sync',async()=>{
  let release,started;const held=new Promise(resolve=>{release=resolve;});const inserting=new Promise(resolve=>{started=resolve;});
  const f=fixture();await f.connect();f.afterInsert(async()=>{started();await held;});
  const first=f.runtime.synchronize();await inserting;
  f.items[0]={...f.items[0],revision:'two',value:{...f.items[0].value,title:'送信中に変更した予定'}};
  const again=f.runtime.synchronize({force:true});const joined=f.runtime.synchronize({force:true});
  release();await Promise.all([first,again,joined]);
  assert.equal([...f.remote.values()][0].summary,'送信中に変更した予定');assert.equal(f.remote.size,1);
  assert.equal(f.calls.filter(x=>x==='patch').length,1,'new requests coalesce one trailing update');
});

test('audit100 restoring an exported recurring series rebinds its exceptions to the new parent without touching old instances',async()=>{
 const f=fixture(1,{tombstones:true,instances:({id,range,remote})=>{
   const key=`instance-${id}`;if(!remote.has(key))remote.set(key,{id:key,recurringEventId:id,originalStartTime:{date:range.originalStart},etag:'instance-etag',summary:'original'});
   return{items:[structuredClone(remote.get(key))]};
 }});
 const series={...f.items[0].value,allDay:true,recurrence:'daily'};f.items[0].value=series;
 const exception={sourceId:'event-0:2026-11-01',parentId:'event-0',anchorDate:'2026-11-01',revision:'exception-1',value:{...series,recurrence:'none',startDate:'2026-11-01',endDate:'2026-11-01',title:'changed instance'}};
 f.items.push(exception);await f.connect();assert.equal((await f.runtime.synchronize()).kind,'success');
 const oldParent=[...f.links.values()].find(row=>row.value.sourceId==='event-0').value.googleId;
 const oldInstance=structuredClone(f.remote.get(`instance-${oldParent}`));
 f.items.splice(1);f.items[0]={sourceId:'event-0',revision:'deleted',value:null};assert.equal((await f.runtime.synchronize()).kind,'success');
 f.items[0]={sourceId:'event-0',revision:'restored',value:series};f.items.push({...exception,revision:'exception-2'});
 assert.equal((await f.runtime.synchronize({force:true})).kind,'success');
 const newParent=[...f.links.values()].find(row=>row.value.sourceId==='event-0').value.googleId;assert.notEqual(newParent,oldParent);
 assert.equal(f.remote.get(`instance-${newParent}`).summary,'changed instance');assert.deepEqual(f.remote.get(`instance-${oldParent}`),oldInstance);
});
