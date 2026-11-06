import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountDeviceApi } from '../src/platform/sharing/account-device-api.ts';

test('account restoration HTTP never redirects credentials and rejects foreign malformed or oversized response bodies', async () => {
  for (const url of ['http://untrusted.example', 'https://user:pass@example.org/', 'https://example.org/path', 'https://example.org/?key=bad']) {
    assert.throws(() => createAccountDeviceApi({ url, userId: 'user', assertCurrent() {}, getToken: async () => 'test-token' }));
  }
  const replies = [
    { redirected: true, url: 'https://foreign.example/', text: async () => '{"records":[]}', headers: new Headers({ 'Content-Type': 'application/json' }), ok: true },
    new Response('provider secret', { status: 503, headers: { 'Content-Type': 'text/html' } }),
    new Response('{"records":[],"extra":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response('x'.repeat(1_048_577), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const reply of replies) {
    const api = createAccountDeviceApi({ url: 'https://account-device.example/', userId: 'user', assertCurrent() {}, getToken: async () => 'test-token',
      fetch: async (url, options) => { assert.equal(new URL(url).pathname, '/v1/restore/read'); assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer test-token'); return reply; } });
    await assert.rejects(api.read('group'), error => !error.message.includes('provider secret'));
  }
});

test('restoration HTTP has a hard budget even if native fetch ignores abort and a late response is never parsed', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let finish, parsed = 0;
  const api = createAccountDeviceApi({ url: 'https://account-device.example/', userId: 'user', assertCurrent() {}, getToken: async () => 'test-token', budgetMs: 1000,
    fetch: async () => new Promise(resolve => { finish = resolve; }) });
  const pending = api.read('group'), rejection = assert.rejects(pending, error => error.code === 'request_timeout');
  await Promise.resolve(); await Promise.resolve(); context.mock.timers.tick(1001); await rejection;
  finish({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), text: async () => { parsed++; return '{"records":[]}'; } });
  await Promise.resolve(); await Promise.resolve(); assert.equal(parsed, 0);
});

test('an account change during token acquisition cannot send its token and transport errors do not reveal token material', async () => {
  let current = true, sent = 0;
  const api = createAccountDeviceApi({ url: 'https://account-device.example/', userId: 'user', assertCurrent() { if (!current) throw new Error('account changed'); },
    getToken: async () => { current = false; return 'secret-token'; }, fetch: async () => { sent++; throw new Error('secret-token'); } });
  await assert.rejects(api.read('group')); assert.equal(sent, 0);
  const failed = createAccountDeviceApi({ url: 'https://account-device.example/', userId: 'user', assertCurrent() {}, getToken: async () => 'secret-token',
    fetch: async () => { throw new Error('secret-token provider internals'); } });
  await assert.rejects(failed.read('group'), error => !error.message.includes('secret-token') && error.code === 'retry_later');
});

test('same-account restoration GET-equivalent reads and uncertain mutations accept only their exact server receipt status', async () => {
  const api = createAccountDeviceApi({ url: 'https://account-device.example/', userId: 'user', assertCurrent() {}, getToken: async () => 'test-token',
    fetch: async () => new Response('{"status":"accepted","unverified":true}', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(api.request({ groupId: 'group', slot: 0, request: {}, replaceRequestId: null }), error => error.code === 'invalid_response');
  const limited = createAccountDeviceApi({ url: 'https://account-device.example/', userId: 'user', assertCurrent() {}, getToken: async () => 'test-token',
    fetch: async () => new Response('{"code":"retry_later"}', { status: 429, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(limited.read('group'), error => error.code === 'retry_later');
});
