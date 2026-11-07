import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {loadNativeModule} from './helpers/native-module.mjs';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'react-native') return { url: 'data:text/javascript,export const Platform = { OS: "ios" };', shortCircuit: true };
  if (specifier === '../../platform/appliance-care/auth') return { url: 'data:text/javascript,let sequence=0;export async function authorizeApplianceCareApi(){if(globalThis.syntheticApplianceAuthPause)await globalThis.syntheticApplianceAuthPause;const id="synthetic-request-"+(++sequence);return {headers:async()=>({authorization:"Bearer synthetic-client", "x-idempotency-key":id})}}', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { analyzeApplianceCareRequest, abortApplianceWait, isApplianceCareUsage } = await import('../src/features/appliance-care/api-client.ts');
const request = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20' };

test('an unreadable completed paid result retains its original admission for retry instead of starting a second charge',async()=>{
  const original=globalThis.fetch;const ids=[];let invalid=true;
  try{
    globalThis.fetch=async(_url,options)=>{
      if(options.method==='POST'){ids.push(options.headers['x-idempotency-key']);return Response.json({jobId:'synthetic-unreadable-result'});}
      return Response.json({stage:'official_manual_analysis',done:true,result:invalid?{status:'verified',analysis:null}
        :{status:'not_found',message:'合成した復旧結果'}});
    };
    const input={...request,modelNumber:'SYNTHETIC-MALFORMED-DONE',forceReanalysis:true};
    assert.equal((await analyzeApplianceCareRequest(input,'https://api.example.test')).code,'TEMPORARY_NETWORK_ERROR');
    invalid=false;assert.equal((await analyzeApplianceCareRequest(input,'https://api.example.test')).status,'not_found');
    assert.equal(ids[0],ids[1],'retry the same paid admission when its returned result was unreadable');
    await analyzeApplianceCareRequest(input,'https://api.example.test');assert.notEqual(ids[1],ids[2]);
  }finally{globalThis.fetch=original;}
});

for(const phase of ['start-fetch','start-body','poll-fetch','poll-body'])test(`appliance timeout settles an unresponsive ${phase} even when native transport ignores abort`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-11-07T00:00:00Z')});
  const original=globalThis.fetch;let release;let settled=false;let answer;
  try{
    globalThis.fetch=async(_url,options)=>{
      const start=options.method==='POST';const target=(start?'start':'poll');
      if(phase===`${target}-fetch`)return new Promise(resolve=>{release=()=>resolve(Response.json({status:'not_found',message:'遅れた合成応答'}));});
      if(phase===`${target}-body`)return {ok:true,json:()=>new Promise(resolve=>{release=()=>resolve({status:'not_found',message:'遅れた合成応答'});})};
      return Response.json({jobId:'synthetic-stalled-transport'});
    };
    const run=analyzeApplianceCareRequest({...request,modelNumber:`SYNTHETIC-${phase}`},'https://api.example.test',1000).then(value=>{settled=true;answer=value;return value;});
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));
    const timely=settled;release();await run;
    assert.equal(timely,true,'timeout must settle without waiting for the ignored native cancellation');
    assert.match(answer.message,/タイムアウト/);assert.notEqual(answer.status,'not_found');
  }finally{release?.();globalThis.fetch=original;}
});

for(const phase of ['fetch','body'])test(`account usage binding also respects its deadline when ${phase} ignores native abort`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-11-07T00:00:00Z')});
  const original=globalThis.fetch;const previous=process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;let release;let settled=false;
  process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL='https://api.example.test';
  try{
    const user={uid:'binding-owner',getIdToken:async()=>'synthetic-id-token'};
    const module=loadNativeModule('src/platform/appliance-care/auth.ts',{
      'expo-crypto':{randomUUID:()=> 'synthetic-binding-request'},
      '../sharing/firebase-services':{isSharingConfigured:()=>true,getSharingServices:()=>({auth:{currentUser:user,authStateReady:async()=>{}}})},
      '../../features/appliance-care/api-client':{abortApplianceWait,isApplianceCareUsage},
    });
    const usage={limit:5,used:0,remaining:5,resetsAt:'2026-12-01T00:00:00Z'};
    globalThis.fetch=async()=>phase==='fetch'?new Promise(resolve=>{release=()=>resolve(Response.json({usage}));})
      :{ok:true,json:()=>new Promise(resolve=>{release=()=>resolve({usage});})};
    const pending=module.bindApplianceAccount(user.uid).then(value=>{settled=true;return value;},error=>{settled=true;return error;});
    while(!release)await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(10000);await new Promise(resolve=>setImmediate(resolve));
    const timely=settled;release();const result=await pending;assert.equal(timely,true);assert.ok(result instanceof Error);
  }finally{release?.();globalThis.fetch=original;if(previous===undefined)delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;else process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL=previous;}
});

test('malformed API results are rejected before screens dereference them', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const payload of [
      { status: 'verified', product: null, officialSources: null, analysis: null },
      { status: 'ambiguous', candidates: [null] },
      { status: 'verified', product: request, officialSources: {}, analysis: { tasks: [null] } },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      const result = await analyzeApplianceCareRequest(request, 'https://api.example.test');
      assert.equal(result.status, 'error');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('valid API errors retain their actionable message', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const payload = { status: 'error', code: 'RATE_LIMITED', message: '少し待って再試行してください。' };
    globalThis.fetch = async () => Response.json(payload, { status: 429 });
    assert.deepEqual(await analyzeApplianceCareRequest(request, 'https://api.example.test'), payload);
  } finally { globalThis.fetch = originalFetch; }
});

test('valid verified analysis still reaches the screen', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const payload = {
      status: 'verified', product: request,
      officialSources: { manualUrl: 'https://www.dyson.co.jp/support/SV20' },
      analysis: {
        manufacturer: 'Dyson', model: 'SV20', analyzedAt: '2026-10-25T00:00:00.000Z', requiresUserReview: true,
        tasks: [{ name: 'フィルター清掃', recommendedIntervalDays: 30, steps: ['ほこりを取る'], tools: [], safetyCautions: [],
          evidence: [{ url: 'https://www.dyson.co.jp/support/SV20' }] }],
      },
    };
    globalThis.fetch = async () => Response.json(payload);
    assert.deepEqual(await analyzeApplianceCareRequest(request, 'https://api.example.test'), payload);
  } finally { globalThis.fetch = originalFetch; }
});

test('stored analysis compatibility never weakens the review and source requirements for newly received API results', async () => {
  const originalFetch = globalThis.fetch;
  const source = 'https://www.dyson.co.jp/support/SV20';
  const task = { name: 'フィルター清掃', steps: ['冷水で洗う'], tools: [], safetyCautions: [], evidence: [{ url: source }], estimatedMinutes: 1 };
  const analysis = { manufacturer: 'Dyson', model: 'SV20', analyzedAt: '2026-10-28T00:00:00Z', requiresUserReview: true, tasks: [task] };
  const response = value => ({ status: 'verified', product: request, officialSources: { manualUrl: source }, analysis: value });
  try {
    for (const value of [
      { analyzedAt: analysis.analyzedAt, tasks: [] }, { ...analysis, tasks: [] }, { ...analysis, requiresUserReview: false },
      { ...analysis, analyzedAt: 'invalid' },
      ...[{ steps: [] }, { evidence: [] }, { evidence: [{ url: 'https://example.test/manual' }] }, { recommendedConditions: [''] },
        { recommendedConditions: '乾燥後' }, { recommendedIntervalDays: 0 }, { estimatedMinutes: -1 }].map(patch => ({ ...analysis, tasks: [{ ...task, ...patch }] })),
    ]) {
      globalThis.fetch = async () => Response.json(response(value));
      assert.equal((await analyzeApplianceCareRequest(request, 'https://api.example.test')).status, 'error');
    }
    globalThis.fetch = async () => Response.json(response(analysis));
    assert.deepEqual(await analyzeApplianceCareRequest(request, 'https://api.example.test'), response(analysis));
  } finally { globalThis.fetch = originalFetch; }
});

test('cancelled appliance requests make no network call and abort an in-flight request', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0; let requestSignal;
    globalThis.fetch = async (_url, options) => {
      calls++; requestSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const cancelled = new AbortController(); cancelled.abort();
    assert.match((await analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, undefined, cancelled.signal)).message, /中断/);
    assert.equal(calls, 0);
    const controller = new AbortController();
    const pending = analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, undefined, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); // Authentication precedes the first HTTP request.
    controller.abort();
    assert.match((await pending).message, /中断/);
    assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance polling stops immediately after cancellation instead of requesting later job updates', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0; const controller = new AbortController();
    globalThis.fetch = async () => {
      calls++;
      return Response.json(calls === 1 ? { jobId: 'job' } : { stage: 'product_verification', done: false, pollAfterMs: 30000 });
    };
    const result = await analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, () => controller.abort(), controller.signal);
    assert.match(result.message, /中断/); assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance client rejects delayed results after cancellation even if fetch ignores abort', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let resolve; const controller = new AbortController();
    globalThis.fetch = () => new Promise((done) => { resolve = done; });
    const pending = analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, undefined, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    resolve(Response.json({ status: 'error', code: 'UNEXPECTED_LATE_RESULT', message: 'stale' }));
    const result = await pending;
    assert.match(result.message, /中断/); assert.notEqual(result.code, 'UNEXPECTED_LATE_RESULT');
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance API retries retain a lost paid admission ID but a later explicit reanalysis gets a fresh ID', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  try {
    globalThis.fetch = async (_url, options) => {
      sent.push(options.headers);
      if (sent.length === 1) throw new Error('synthetic connection lost after admission');
      return Response.json({ status: 'not_found', message: '合成した検索結果' });
    };
    const retry = { ...request, modelNumber: 'SYNTHETIC-IDEMPOTENCY', forceReanalysis: true };
    assert.equal((await analyzeApplianceCareRequest(retry, 'https://api.example.test')).status, 'error');
    assert.equal((await analyzeApplianceCareRequest(retry, 'https://api.example.test')).status, 'not_found');
    assert.equal((await analyzeApplianceCareRequest(retry, 'https://api.example.test')).status, 'not_found');
    assert.equal(sent[0]['x-idempotency-key'], sent[1]['x-idempotency-key']);
    assert.notEqual(sent[1]['x-idempotency-key'], sent[2]['x-idempotency-key']);
    assert.ok(sent.every(item => item.authorization === 'Bearer synthetic-client'));
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance API usage metadata is validated before an untrusted quota value can reach native text', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const usage of [null, { remaining: { toString: null } }, { limit: 5, used: 4, remaining: 2, resetsAt: '2026-11-01T00:00:00Z' }]) {
      globalThis.fetch = async () => Response.json({ status: 'not_found', message: '合成した検索結果', usage });
      assert.equal((await analyzeApplianceCareRequest(request, 'https://api.example.test')).status, 'error');
    }
    const usage = { limit: 5, used: 4, remaining: 1, resetsAt: '2026-11-01T00:00:00Z' };
    globalThis.fetch = async () => Response.json({ status: 'not_found', message: '合成した検索結果', usage });
    assert.deepEqual((await analyzeApplianceCareRequest(request, 'https://api.example.test')).usage, usage);
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance cancellation and timeout finish promptly while authentication is stalled and never send a late paid request', async () => {
  const originalFetch = globalThis.fetch; let release; let calls = 0;
  try {
    globalThis.syntheticApplianceAuthPause = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async () => { calls++; throw new Error('must not start'); };
    const controller = new AbortController();
    const cancelled = analyzeApplianceCareRequest(request, 'https://api.example.test', 10_000, undefined, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.match((await cancelled).message, /中断/);
    assert.match((await analyzeApplianceCareRequest(request, 'https://api.example.test', 5)).message, /タイムアウト/);
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
  } finally { release?.(); delete globalThis.syntheticApplianceAuthPause; globalThis.fetch = originalFetch; }
});

test('appliance authenticated upload and polls explicitly reject redirects rather than forwarding credentials to another host', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  try {
    globalThis.fetch = async (_url, options) => {
      sent.push(options); assert.equal(options.redirect, 'error');
      return options.method === 'POST' ? Response.json({ jobId: 'synthetic-redirect-test' }, { status: 202 })
        : Response.json({ stage: 'official_manual_analysis', done: true, result: { status: 'error', code: 'ANALYSIS_FAILED', message: '合成した検査結果' } });
    };
    const result = await analyzeApplianceCareRequest({ ...request, manual: { base64: 'synthetic-file', rightsConfirmed: true } });
    assert.equal(result.status, 'error'); assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(sent[0].body).manual, { base64: 'synthetic-file', rightsConfirmed: true });
  } finally { globalThis.fetch = originalFetch; }
});
