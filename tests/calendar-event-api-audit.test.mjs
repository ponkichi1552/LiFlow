import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleCalendarApi } from '../src/platform/google-calendar/calendar-api.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

for (const phase of ['guard', 'credential', 'fetch', 'body']) test(`Calendar cancellation ends an ignored native ${phase} wait and prevents late work`, async () => {
  const controller = new AbortController(); let release; let entered = false; let requests = 0, bodies = 0, tokens = 0;
  const hold = () => { entered = true; return new Promise(resolve => { release = resolve; }); };
  const response = { ok: true, status: 200, text: async () => { bodies++; return phase === 'body' ? hold() : '{"id":"synthetic"}'; } };
  const api = createGoogleCalendarApi({ signal: controller.signal,
    assertCurrent: async () => { if (phase === 'guard') await hold(); },
    token: async () => { tokens++; return phase === 'credential' ? hold() : 'synthetic-token'; },
    fetch: async () => { requests++; return phase === 'fetch' ? hold() : response; },
  });
  let status = 'waiting'; let error;
  const pending = api.get('synthetic-calendar', 'synthetic-event').then(() => { status = 'fulfilled'; }, cause => { status = 'rejected'; error = cause; });
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  try {
    await flush(); assert.equal(entered, true); controller.abort(); await flush();
    assert.equal(status, 'rejected'); assert.equal(error?.name, 'AbortError');
    release(phase === 'fetch' ? response : phase === 'credential' ? 'synthetic-late-token' : phase === 'body' ? 'PRIVATE-BODY must not be parsed' : undefined);
    await pending; await flush();
    assert.equal(tokens, phase === 'guard' ? 0 : 1);
    assert.equal(requests, ['guard', 'credential'].includes(phase) ? 0 : 1);
    assert.equal(bodies, phase === 'body' ? 1 : 0);
    await assert.rejects(api.get('synthetic-calendar', 'another-event'), cause => cause.name === 'AbortError');
    assert.equal(requests, ['guard', 'credential'].includes(phase) ? 0 : 1);
    assert.equal(error.message.includes('PRIVATE'), false);
  } finally {
    release?.(phase === 'fetch' ? response : phase === 'credential' ? 'synthetic-late-token' : phase === 'body' ? '{}' : undefined);
  }
});

test('Calendar concurrent requests share one cancellation listener and release it after their final response', async t => {
  const controller = new AbortController(); const signal = controller.signal; let added = 0, removed = 0;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  t.mock.method(signal, 'addEventListener', (...args) => { added++; return add(...args); });
  t.mock.method(signal, 'removeEventListener', (...args) => { removed++; return remove(...args); });
  const api = createGoogleCalendarApi({ signal, assertCurrent: async () => {}, token: async () => 'synthetic',
    fetch: async url => Response.json({ id: decodeURIComponent(new URL(url).pathname.split('/').at(-1)) }) });
  await Promise.all(Array.from({ length: 100 }, () => api.get('synthetic-calendar', 'synthetic-event')));
  assert.equal(added, 1); assert.equal(removed, 1);
  await api.get('synthetic-calendar', 'another-event'); assert.equal(added, 2); assert.equal(removed, 2);
  controller.abort(); await assert.rejects(api.get('synthetic-calendar', 'cancelled'), cause => cause.name === 'AbortError');
  assert.equal(added, 2); assert.equal(removed, 2);
});

test('one bounded Calendar API pass shares its token acquisition but checks account access around every HTTP response', async () => {
  let tokens = 0, guards = 0, calls = 0, forbidden = false;
  const api = createGoogleCalendarApi({ token: async () => { tokens++; return 'synthetic-token'; },
    assertCurrent: async () => { guards++; if (forbidden) throw new Error('account changed'); },
    fetch: async url => { calls++; return new Response(JSON.stringify({ id: decodeURIComponent(new URL(url).pathname.split('/').at(-1)), etag: 'etag' }), { status: 200 }); } });
  await Promise.all(Array.from({ length: 100 }, () => api.get('test', 'event')));
  assert.equal(tokens, 1); assert.equal(calls, 100); assert.equal(guards, 400);
  forbidden = true; await assert.rejects(api.get('test', 'event'), /account changed/); assert.equal(calls, 100);
});

test('Calendar HTTP rejects malformed JSON privately and honors both forms of Retry-After', async () => {
  const now = Date.now();
  for (const retry of ['120', new Date(now + 120_000).toUTCString()]) {
    const api = createGoogleCalendarApi({ token: async () => 'synthetic', assertCurrent: async () => {},
      fetch: async () => new Response('{}', { status: 429, headers: { 'Retry-After': retry } }) });
    await assert.rejects(api.get('test', 'event'), error => error.retryAfterMs >= 118_000 && error.retryAfterMs <= 121_000);
  }
  const api = createGoogleCalendarApi({ token: async () => 'synthetic', assertCurrent: async () => {},
    fetch: async () => new Response('PRIVATE-CALENDAR-CONTENT is malformed', { status: 200 }) });
  await assert.rejects(api.get('test', 'event'), error => !error.message.includes('PRIVATE-CALENDAR-CONTENT') && /応答/.test(error.message));
});

test('Google DTSTART is the first real custom occurrence including interval phase month ordinals and empty finite series', () => {
  const base = { ...newEventDraft('2028-11-01', 'Asia/Tokyo'), title: 'Synthetic', recurrence: 'custom' };
  for (const [startDate, rule] of [
    ['2028-11-01', { unit: 'week', interval: 2, weekdays: [1, 4] }],
    ['2028-11-03', { unit: 'week', interval: 8, weekdays: [0, 1] }],
    ['2028-11-01', { unit: 'month', interval: 2, on: 'weekday', ordinal: -1, weekday: 5 }],
    ['2027-01-31', { unit: 'month', interval: 2, on: 'weekday', ordinal: 1, weekday: 1 }],
  ]) {
    const value = { ...base, startDate, endDate: startDate, customRecurrence: rule };
    const occurrences = projectCalendarEvents([{ ...value, id: 'test', revision: 1 }], [], startDate, startDate.slice(0, 4) + '-12-31');
    const body = googleEventBody(value); assert.equal(body.start.dateTime.slice(0, 10), occurrences[0].startDate);
    assert.equal(Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime), 3600_000);
  }
  assert.equal(googleEventBody({ ...base, customRecurrence: { unit: 'week', interval: 2, weekdays: [1, 4] }, untilDate: '2028-11-01' }), null);
  const one = googleEventBody({ ...base, customRecurrence: { unit: 'week', interval: 2, weekdays: [1, 4] } }, true);
  assert.equal(one.start.dateTime.slice(0, 10), '2028-11-01'); assert.equal(one.recurrence, undefined);
});

test('audit100 Calendar reads and write acknowledgements request only used event fields while keeping cursor privacy and conflict evidence',async()=>{
 const {createGoogleCalendarApi}=await import('../src/platform/google-calendar/calendar-api.ts');const urls=[];
 const api=createGoogleCalendarApi({assertCurrent:async()=>{},token:async()=> 'synthetic-token',fetch:async(url,init)=>{urls.push(new URL(url));return Response.json(init?.method==='POST'?{id:'event'}:{id:'event',items:[],nextSyncToken:'next'});}});
 await api.events('calendar',{});await api.instances('calendar','parent',{});await api.get('calendar','event');await api.insert('calendar',{id:'event',summary:'予定'});await api.patch('calendar','event',{summary:'変更'},'"etag"');
 for(const url of urls){const fields=url.searchParams.get('fields');assert.ok(fields,`full Calendar response requested: ${url.pathname}`);for(const field of ['etag','status','recurrence','originalStartTime','updated','visibility','locked','htmlLink','extendedProperties'])assert.ok(fields.includes(field),`missing ${field}`);for(const unused of ['attendees','attachments','conferenceData','reminders'])assert.equal(fields.includes(unused),false);}
 assert.match(urls[0].searchParams.get('fields'),/nextSyncToken/);assert.match(urls[1].searchParams.get('fields'),/nextPageToken/);
});
