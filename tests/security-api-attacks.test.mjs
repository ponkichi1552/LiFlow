import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { officialDomainsForManufacturer } from '../server/appliance-care-api/src/official-domains.mjs';
import { resolveProduct } from '../server/appliance-care-api/src/product-resolver.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { fetchOfficialManualText } from '../server/appliance-care-api/src/manual-resolver.mjs';

const request = i => ({ manufacturer: 'Dyson', productName: `Synthetic${i}`, modelNumber: `QA${i}` });

test('API security unauthenticated development server refuses production startup before opening a listener or invoking AI', () => {
  const source = `import {createApplianceCareHttpServer,startApplianceCareHttpServer} from ${JSON.stringify(new URL('../server/appliance-care-api/src/http-server.mjs', import.meta.url).href)};
    for(const create of [createApplianceCareHttpServer,startApplianceCareHttpServer]) {
      let refused=false;
      try { const server=create({aiConfigured:false,host:'127.0.0.1',port:0,dependencies:new Proxy({}, {get(){throw new Error('dependencies must not be touched')}})});server.close(); }
      catch(error) {if(error.code!=='DEVELOPMENT_API_ONLY')throw error;refused=true;}
      if(!refused)throw new Error('Unauthenticated production server was created');
    }
    console.log('production-startup-refused');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, NODE_ENV: 'production', OPENAI_API_KEY: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'production-startup-refused');
});

test('API attack: hardened manual cleanup preserves visible custom elements self-closing markup and Japanese procedures', async () => {
  const html = '<nav>不要なリンク</nav><!-- 隠れた内容 --><h2>お手入れ</h2><nav-link>確認する</nav-link><svg/><p>フィルターを洗う &amp; 乾かす</p><br><script>非表示のスクリプト</script><style>非表示のスタイル</style><p>次の工程</p>';
  const result = await fetchOfficialManualText({ url: 'https://dyson.co.jp/synthetic', kind: 'web_manual' }, ['dyson.co.jp'],
    async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  for (const text of ['お手入れ', '確認する', 'フィルターを洗う & 乾かす', '次の工程']) assert.ok(result.text.includes(text), text);
  for (const hidden of ['不要なリンク', '隠れた内容', '非表示のスクリプト', '非表示のスタイル']) assert.equal(result.text.includes(hidden), false, hidden);
  assert.ok(result.text.includes('\n\n'));
});

test('API attack: bounded malformed official HTML cannot trap the process in repeated unclosed-tag or comment scans', () => {
  const source = `import {fetchOfficialManualText} from ${JSON.stringify(new URL('../server/appliance-care-api/src/manual-resolver.mjs', import.meta.url).href)};
    const lengths=[];const began=Date.now();
    for(const html of ['<script>'.repeat(250000),'<!--'.repeat(500000),'<'.repeat(2000000)]){
      const result=await fetchOfficialManualText({url:'https://dyson.co.jp/synthetic',kind:'web_manual'},['dyson.co.jp'],
        async()=>new Response(html,{headers:{'content-type':'text/html'}}));lengths.push(result.text.length);
    }
    console.log(JSON.stringify({lengths,elapsedMs:Date.now()-began}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).lengths, [0, 0, 2000000]);
});
async function fixture(options = {}) {
  let analyses = 0;
  const server = createApplianceCareHttpServer({ dependencies: { resolveProduct: async () => { analyses++; return { status: 'not_found' }; } }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, analyses: () => analyses, post: (body, headers = {}) => fetch(`${base}/api/appliance-care/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  close: async () => { const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing; } };
}

test('API attack: prototype property manufacturers cannot escape the official-domain allowlist or start an AI request', async () => {
  let calls = 0;
  for (const name of new Set([...Object.getOwnPropertyNames(Object.prototype), 'constructor', '__proto__', ' Constructor ', 'ＣＯＮＳＴＲＵＣＴＯＲ'])) {
    assert.deepEqual(officialDomainsForManufacturer(name), [], name);
    assert.deepEqual(await resolveProduct({ ...request(0), manufacturer: name }, { ai: { createStructured: async () => { calls++; throw new Error('unapproved AI request'); } } }), { status: 'not_found' });
  }
  assert.equal(calls, 0); assert.deepEqual(officialDomainsForManufacturer('ダイソン'), ['dyson.co.jp']);
});

test('API attack: an oversized unfinished upload is rejected before the attacker ends the body and releases its connection', async () => {
  const f = await fixture({ aiConfigured: false }); let upload;
  try {
    const response = new Promise(resolve => {
      upload = http.request(`${f.base}/api/appliance-care/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, res => {
        res.resume(); res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection }));
      });
      upload.on('error', error => resolve({ error: error.code }));
      upload.write('{"untrusted":"' + 'x'.repeat(9000)); // Deliberately never call end().
    });
    const outcome = await Promise.race([response, delay(750).then(() => ({ timedOut: true }))]);
    assert.equal(outcome.status, 413, JSON.stringify(outcome)); assert.equal(outcome.connection, 'close');
    assert.equal(f.analyses(), 0); assert.equal((await fetch(`${f.base}/health`)).status, 200);
  } finally { upload?.destroy(); await f.close(); }
});

test('API attack: many distinct jobs cannot evict a retained result before its promised lifetime and capacity recovers after expiry', async () => {
  const originalNow = Date.now; let clock = originalNow(); Date.now = () => clock;
  const f = await fixture();
  try {
    let first; let denied = 0;
    for (let i = 0; i < 120; i++) {
      if (i && i % 20 === 0) clock += 60_001;
      const response = await f.post(request(i)); const body = await response.json();
      if (response.status === 202) first ??= body.jobId;
      else { assert.equal(response.status, 429); denied++; }
    }
    const original = await fetch(`${f.base}/api/appliance-care/jobs/${first}`);
    assert.equal(original.status, 200, 'new requests must not delete another client result before ten minutes');
    assert.equal((await original.json()).done, true); assert.ok(denied > 0, 'full storage uses backpressure');
    assert.ok(f.analyses() <= 20, 'an attack cannot bypass the existing process-wide AI budget');
    clock += 600_001;
    assert.equal((await f.post(request('after-expiry'))).status, 202);
    assert.equal((await fetch(`${f.base}/api/appliance-care/jobs/${first}`)).status, 404);
  } finally { Date.now = originalNow; await f.close(); }
});

test('API attack: JSON-like media types are rejected while parameterized JSON remains compatible', async () => {
  const f = await fixture({ aiConfigured: false });
  try {
    for (const type of ['application/jsonp', 'application/json-malicious', 'application/json+xml', 'text/plain']) {
      assert.equal((await f.post(request(type), { 'content-type': type })).status, 415, type);
    }
    assert.equal((await f.post(request('valid'), { 'content-type': 'Application/JSON; charset=UTF-8' })).status, 503);
    assert.equal(f.analyses(), 0);
  } finally { await f.close(); }
});

test('API attack: spoofed forwarding addresses do not bypass admission limits and CORS only reflects a configured exact origin', async () => {
  const f = await fixture({ aiConfigured: false, allowedOrigins: ['https://allowed.example'] });
  try {
    for (const origin of ['https://allowed.example.attacker.example', 'https://attacker.example', 'null', 'http://allowed.example']) {
      const response = await f.post(request(origin), { origin }); assert.equal(response.status, 403); assert.equal(response.headers.has('access-control-allow-origin'), false);
    }
    const allowed = await f.post(request('allowed'), { origin: 'https://allowed.example' });
    assert.equal(allowed.status, 503); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
    for (let i = 0; i < 19; i++) assert.equal((await f.post(request(i), { 'x-forwarded-for': `198.51.100.${i}` })).status, 503);
    assert.equal((await f.post(request('over-limit'), { 'x-forwarded-for': '203.0.113.250' })).status, 429);
    assert.equal(f.analyses(), 0);
  } finally { await f.close(); }
});

test('API attack: ambiguous content-length and transfer-encoding is rejected by the strict HTTP parser before analysis', async () => {
  const f = await fixture(); let socket;
  try {
    const reply = new Promise(resolve => {
      socket = net.connect(f.server.address().port, '127.0.0.1', () => socket.write('POST /api/appliance-care/jobs HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n'));
      let data = ''; socket.on('data', chunk => { data += chunk.toString(); }); socket.on('end', () => resolve(data)); socket.on('error', () => resolve(data));
    });
    const result = await Promise.race([reply, delay(750).then(() => '')]); assert.match(result, /^HTTP\/1\.1 400/u); assert.equal(f.analyses(), 0);
  } finally { socket?.destroy(); await f.close(); }
});
