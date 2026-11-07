import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSharedGoogleCalendarExport } from '../src/features/calendar/shared-google-export.ts';
import { createGoogleCalendarApi } from '../src/platform/google-calendar/calendar-api.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

async function fixture(t, count) {
  const remote = new Map(), links = new Map(); let requests = 0, tokens = 0, lose;
  const items = Array.from({ length: count }, (_, i) => ({ sourceId: `synthetic.${i}`, revision: 'one',
    value: { ...newEventDraft('2026-11-01', 'Asia/Tokyo'), title: `Synthetic ${i}`, allDay: i % 2 === 0 } }));
  let control = { enabled: true, revision: 1, subject: 'synthetic-subject', calendarId: 'synthetic-calendar', retryAt: null, retryCount: 0 };
  const normalize = value => Object.fromEntries(Object.entries(value).filter(([key, contents]) => contents !== '' && !(key === 'transparency' && contents === 'opaque') && !(key === 'recurrence' && !contents.length)));
  const server = createServer(async (req, res) => {
    requests++; assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    const text = []; for await (const chunk of req) text.push(chunk); const body = text.length ? JSON.parse(Buffer.concat(text).toString()) : null;
    const id = decodeURIComponent(new URL(req.url, 'http://local').pathname.split('/')[6] ?? '');
    const finish = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(payload === undefined ? undefined : JSON.stringify(payload)); };
    if (req.method === 'POST') {
      if (remote.has(body.id)) return finish(409, {});
      const row = { ...normalize(body), etag: '"one"' }; remote.set(body.id, row);
      if (lose === 'insert') { lose = undefined; res.destroy(); return; } return finish(200, row);
    }
    const row = remote.get(id); if (!row) return finish(404, {});
    if (req.method === 'GET') return finish(200, row);
    if (req.headers['if-match'] !== row.etag) return finish(412, {});
    if (req.method === 'PATCH') {
      const next = { ...row, ...body, etag: `${row.etag.slice(0, -1)}x"` };
      for (const key of ['location', 'description', 'transparency', 'recurrence']) if (Object.hasOwn(body, key) && !Object.hasOwn(normalize(body), key)) delete next[key];
      remote.set(id, normalize(next));
      if (lose === 'patch') { lose = undefined; res.destroy(); return; } return finish(200, remote.get(id));
    }
    remote.delete(id); return finish(204);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const store = { readControl: async () => ({ ...control }), readItems: async () => items,
    readLinks: async () => [...links.values()], saveLink: async (_subject, _calendar, link) => { links.set(link.sourceId, { ...link }); },
    saveStatus: async (revision, patch) => { if (control.revision === revision) control = { ...control, ...patch }; } };
  const open = () => createSharedGoogleCalendarExport({ store, scope: { userId: 'synthetic', groupId: 'synthetic-group' },
    assertAccess: async () => {}, currentSubject: async () => 'synthetic-subject', authorize: async () => { assert.fail('background work must not request consent'); },
    createApi: context => createGoogleCalendarApi({ ...context, token: async () => { tokens++; return 'synthetic-token'; },
      fetch: (resource, init) => fetch(url + new URL(resource).pathname + new URL(resource).search, init) }) });
  return { items, links, remote, open, counts: () => ({ requests, tokens }), lose: method => { lose = method; },
    disable: () => { control = { ...control, enabled: false, revision: control.revision + 1 }; } };
}

test('real loopback HTTP exports 1052 events in bounded coalesced passes and unchanged or disabled passes issue no requests', async t => {
  const f = await fixture(t, 1052); const runtime = f.open();
  const first = runtime.synchronize(); for (let n = 0; n < 50; n++) assert.equal(runtime.synchronize(), first);
  assert.deepEqual(await first, { kind: 'pending', sent: 100 }); assert.equal(f.counts().requests, 100); assert.equal(f.counts().tokens, 1);
  let batches = 1;
  while (f.links.size < 1052) {
    const before = f.counts(); const result = await f.open().synchronize({ force: true }); batches++;
    assert.ok(f.counts().requests - before.requests <= 100); assert.equal(f.counts().tokens - before.tokens, 1);
    assert.equal(result.sent, batches === 11 ? 52 : 100);
  }
  assert.equal(batches, 11); assert.equal(f.remote.size, 1052);
  const before = f.counts(); assert.deepEqual(await runtime.synchronize(), { kind: 'success', sent: 0 });
  f.disable(); assert.deepEqual(await runtime.synchronize(), { kind: 'skipped', sent: 0 });
  assert.deepEqual(f.counts(), before); assert.equal(f.remote.size, 1052);
});

test('real HTTP disconnection after Google-like commit retries insert patch and delete without duplicate events or source changes', async t => {
  const f = await fixture(t, 1); const source = JSON.stringify(f.items); f.lose('insert');
  assert.equal((await f.open().synchronize()).kind, 'error'); assert.equal(f.remote.size, 1); assert.equal(f.links.size, 1);
  assert.ok([...f.links.values()][0].pending); assert.equal([...f.links.values()][0].revision, '');
  assert.deepEqual(await f.open().synchronize({ force: true }), { kind: 'success', sent: 1 }); assert.equal(f.remote.size, 1);
  f.items[0] = { ...f.items[0], revision: 'two', value: { ...f.items[0].value, title: 'Synthetic updated' } }; f.lose('patch');
  assert.equal((await f.open().synchronize({ force: true })).kind, 'error');
  assert.deepEqual(await f.open().synchronize({ force: true }), { kind: 'success', sent: 1 }); assert.equal(f.remote.size, 1);
  f.items[0] = { ...f.items[0], revision: 'deleted', value: null };
  assert.deepEqual(await f.open().synchronize({ force: true }), { kind: 'success', sent: 1 }); assert.equal(f.remote.size, 0);
  assert.equal(f.links.get('synthetic.0').deleted, true); assert.ok(source.includes('Synthetic 0'));
});
