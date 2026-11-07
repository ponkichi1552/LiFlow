import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTasksApi, GoogleTasksApiError } from '../src/platform/google-tasks/google-tasks-api.ts';
import { createGoogleCalendarApi, GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
const { createCalendarFreeBusyClient } = await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');

test('audit50 Google transports stop oversized streamed bodies before parsing or retaining their full content', async () => {
  for (const provider of ['Tasks', 'Calendar', 'FreeBusy']) {
    let pulls = 0; let cancelled = false;
    const response = () => new Response(new ReadableStream({ pull(controller) { pulls++; if (pulls <= 150) controller.enqueue(new Uint8Array(100_000).fill(32)); else { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }, cancel() { cancelled = true; } }));
    const tasks = createGoogleTasksApi(async () => response());
    const calendar = createGoogleCalendarApi({ token: async () => 'test', assertCurrent: async () => {}, fetch: async () => response() });
    const freebusy = createCalendarFreeBusyClient(async () => response());
    const action = provider === 'Tasks' ? () => tasks.getTask('test', 'list', 'task') : provider === 'Calendar' ? () => calendar.events('primary', {}) : () => freebusy.query('test', { timeMin: '2026-11-07T00:00:00Z', timeMax: '2026-11-08T00:00:00Z', timeZone: 'UTC' }, { maxIntervals: 100 });
    await assert.rejects(action(), error => error instanceof Error);
    assert.ok(pulls < 100, `${provider} consumed ${pulls} chunks`); assert.equal(cancelled, true, `${provider} must stop unused transfer`);
  }
  const large = new Response('{}', { headers: { 'Content-Length': '999999999' } });
  const api = createGoogleTasksApi(async () => large);
  await assert.rejects(api.getTask('test', 'list', 'task'), error => error instanceof GoogleTasksApiError && error.status === 502);
});

test('audit50 Calendar403 quota responses are reported as retryable limits rather than requesting OAuth again', async () => {
  const make = reason => createGoogleCalendarApi({ token: async () => 'test', assertCurrent: async () => {}, fetch: async () => Response.json({ error: { errors: [{ reason }] } }, { status: 403, headers: { 'Retry-After': '60' } }) });
  await assert.rejects(make('rateLimitExceeded').events('primary', {}), error => error instanceof GoogleCalendarHttpError && error.status === 429 && error.retryAfterMs === 60_000 && !error.message.includes('アクセス権限'));
  await assert.rejects(make('forbidden').events('primary', {}), error => error instanceof GoogleCalendarHttpError && error.status === 403 && error.message.includes('アクセス権限'));
});

test('audit50 native text only Google bodies enforce actual UTF8 bytes without requiring stream methods', async () => {
  const { readGoogleResponseText, GoogleResponseTooLargeError } = await import('../src/platform/google-http/bounded-body.ts');
  const response = text => ({ body: {}, headers: new Headers(), text: async () => text });
  assert.equal(await readGoogleResponseText(response('正常'), undefined, 6), '正常');
  await assert.rejects(readGoogleResponseText(response('正常'), undefined, 5), GoogleResponseTooLargeError);
  await assert.rejects(readGoogleResponseText({ ...response('small'), headers: new Headers({ 'Content-Length': '100' }) }, undefined, 20), GoogleResponseTooLargeError);
  const controller = new AbortController(); controller.abort(); await assert.rejects(readGoogleResponseText(response('x'), controller.signal));
});
