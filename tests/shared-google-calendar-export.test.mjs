import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedGoogleCalendarExport } from '../src/features/calendar/shared-google-export.ts';
import { GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

function fixture(count = 1, options = {}) {
  let control = { enabled: false, revision: 0, subject: null, calendarId: null, retryCount: 0, retryAt: null }; let subject = 'google-user';
  const items = Array.from({ length: count }, (_, i) => ({ sourceId: `event-${i}`, revision: 'one', value: { ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: `共有${i}` } }));
  const links = new Map(); const remote = new Map(); const calls = []; let afterInsert = async () => {};
  const runtime = createSharedGoogleCalendarExport({ scope: { userId: 'owner', groupId: 'home' }, now: () => 1_000_000, random: () => .5,
    assertAccess: async () => {}, currentSubject: async () => subject, authorize: async () => { await options.authorize?.(); return { subject, label: '検査アカウント' }; },
    store: {
      readControl: async () => ({ ...control }), configure: async (patch, revision) => { assert.equal(revision, control.revision); control = { ...control, ...patch, revision: revision + 1 }; return { ...control }; },
      saveStatus: async (revision, patch) => { if (revision === control.revision) control = { ...control, ...patch }; },
      readItems: async () => { await options.readItems?.(); return items; }, readLinks: async (sub, cal) => [...links.values()].filter(row => row.subject === sub && row.calendar === cal).map(row => row.value),
      saveLink: async (sub, cal, value) => { links.set(`${sub}:${cal}:${value.sourceId}`, { subject: sub, calendar: cal, value: { ...value } }); },
    }, createApi: context => ({
      calendars: async () => { await context.assertCurrent(); calls.push('calendars'); return { items: [{ id: 'cal', summary: '個人', accessRole: 'owner' }, { id: 'readonly', summary: '祝日', accessRole: 'reader' }] }; },
      insert: async (_cal, body) => { await context.assertCurrent(); calls.push('insert'); if (remote.has(body.id)) throw new GoogleCalendarHttpError(409);
        const row = { ...structuredClone(body), etag: 'etag1' }; remote.set(body.id, row); await afterInsert(); return structuredClone(row); },
      get: async (_cal, id) => { await context.assertCurrent(); calls.push('get'); if (!remote.has(id)) throw new GoogleCalendarHttpError(404); return structuredClone(remote.get(id)); },
      patch: async (_cal, id, body, etag) => { await context.assertCurrent(); calls.push('patch'); const old = remote.get(id); if (!old || old.etag !== etag) throw new GoogleCalendarHttpError(412);
        const row = { ...old, ...structuredClone(body), etag: old.etag + 'x' }; remote.set(id, row); return structuredClone(row); },
      remove: async (_cal, id, etag) => { await context.assertCurrent(); calls.push('delete'); if (remote.get(id)?.etag !== etag) throw new GoogleCalendarHttpError(412); remote.delete(id); },
      instances: async (_cal, id, range) => { await context.assertCurrent(); calls.push('instances'); return options.instances?.({ id, range, remote }) ?? { items: [] }; },
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
  f.items[0].value = { ...f.items[0].value, recurrence: 'weekly', startMinute: 30, endMinute: 90 };
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
      readLinks: async () => [], saveStatus: async (_revision, patch) => { control = { ...control, ...patch }; }, saveLink: async () => { assert.fail('an aborted request is not acknowledged'); } },
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
    prepareConnection: async () => { calls.push(['prepare']); return review; }, connect: async (current, id) => { assert.equal(current, review); assert.equal(id, 'calendar'); calls.push(['connect']); control = { ...control, enabled: true, revision: control.revision + 1 }; } };
  const screen = screenHarness('src/features/calendar/shared-google-settings.tsx', { exportName: 'SharedGoogleCalendarSettings', platform, effectDependencies: true, effect: callback => callback(), props: { runtime, onBack() {} } });
  try {
    await screen.flush(); assert.deepEqual(calls, [], 'mounting never authorizes or synchronizes Google');
    await screen.press('今すぐ追加・更新'); await screen.flush();
    assert.deepEqual(calls, [['sync', { force: true, interactive: true }]]);
    const toggle = () => screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '共有予定をGoogleカレンダーに追加');
    toggle().props.onValueChange(false); await screen.flush(); await screen.flush();
    assert.equal(toggle().props.value, false); assert.deepEqual(calls.at(-1), ['off']);
    toggle().props.onValueChange(true); await screen.flush(); await screen.flush();
    assert.deepEqual(calls.at(-1), ['prepare']); await screen.press('QA Calendar'); await screen.flush();
    assert.deepEqual(calls.slice(-2), [['connect'], ['sync', { force: true, interactive: true }]]);
    assert.equal(toggle().props.value, true);
  } finally { screen.unmount(); }
});
