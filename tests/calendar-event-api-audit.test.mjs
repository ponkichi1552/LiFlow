import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleCalendarApi } from '../src/platform/google-calendar/calendar-api.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

test('one bounded Calendar API pass shares its token acquisition but checks account access around every HTTP response', async () => {
  let tokens = 0, guards = 0, calls = 0, forbidden = false;
  const api = createGoogleCalendarApi({ token: async () => { tokens++; return 'synthetic-token'; },
    assertCurrent: async () => { guards++; if (forbidden) throw new Error('account changed'); },
    fetch: async () => { calls++; return new Response(JSON.stringify({ id: 'synthetic', etag: 'etag' }), { status: 200 }); } });
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
