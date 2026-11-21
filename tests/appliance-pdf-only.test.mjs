import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { syntheticManual } from './helpers/synthetic-pdf.mjs';
import { publicStoreFixture, syntheticAnalysisQueueKeys } from './helpers/appliance-public-store.mjs';
import { validateApplianceCareRequest } from '../server/appliance-care-api/src/service.mjs';
import { analyzeUploadedManual, decodeUploadedManual, UPLOADED_MANUAL_SCHEMA } from '../server/appliance-care-api/src/uploaded-manual.mjs';
import { productFromUploadedManual, UPLOADED_PRODUCT_CATEGORIES } from '../server/appliance-care-api/src/uploaded-product.mjs';
import { applianceCategoryOptions } from '../src/features/appliance-care/categories.ts';
import { analysisRequestKey } from '../server/appliance-care-api/src/analysis-runner.mjs';
import { prepareAnalysisQueueInput, decodeAnalysisQueueInput } from '../server/appliance-care-api/src/analysis-queue-input.mjs';
import { publicKey, createPublicApiAccess } from '../server/appliance-care-api/src/public-access.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { runAnalysisQueueBatch } from '../server/appliance-care-api/src/analysis-queue-worker.mjs';
import { createFirestoreUsageStore } from '../server/appliance-care-api/src/firestore-usage-store.mjs';
import { isVerifiedApplianceAnalysis } from '../src/features/appliance-care/analysis-validation.ts';

const product = { manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumbers: ['SV20'], category: 'vacuum_cleaner' };
const automatic = () => ({ identifyFromManual: true, manual: decodeUploadedManual(syntheticManual()) });
const task = manual => ({ name: 'フィルターのお手入れ', recommendedIntervalDays: 30, recommendedConditions: [],
  steps: ['電源を切り、フィルターを外す。'], tools: [], safetyCautions: ['十分に乾燥させる。'], estimatedMinutes: null,
  evidence: [{ url: manual.reference, pageOrSection: '1ページ' }] });

test('PDF-only requests require no product fields and keep strict legacy and reanalysis validation', () => {
  const input = automatic(); assert.equal(validateApplianceCareRequest(input), true);
  for (const change of [{ identifyFromManual: false }, { identifyFromManual: 'true' }, { manual: undefined }, { manual: [] },
    { manufacturer: 'Dyson' }, { manufacturer: 1, productName: 'a', modelNumber: 'x' }]) {
    assert.equal(validateApplianceCareRequest({ ...input, ...change }), false);
  }
  const expected = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20' };
  assert.equal(validateApplianceCareRequest(expected), true);
  assert.equal(validateApplianceCareRequest({ ...input, ...expected, forceReanalysis: true }), true);
  assert.equal(validateApplianceCareRequest({ manual: input.manual }), false, 'legacy requests do not silently become unidentified jobs');
});

test('one uploaded PDF call extracts its own product and care tasks without any identity hints or external fetch', async () => {
  const input = automatic(); let calls = 0; let sent;
  const result = await analyzeUploadedManual(input, { analyzeUploaded: async value => {
    calls++; sent = value; return { value: { product, tasks: [task(input.manual)] } };
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'verified'); assert.equal(sent.schema, UPLOADED_MANUAL_SCHEMA);
  assert.deepEqual(result.product, { manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20', category: 'vacuum_cleaner' });
  assert.match(contentPrompt(sent), /家電の種類/u);
  assert.equal(isVerifiedApplianceAnalysis(result.analysis, 'Dyson'), true);
  assert.equal(result.analysis.model, 'SV20'); assert.equal(sent.tools, undefined);
  const content = sent.input[1].content;
  assert.equal(content.filter(part => part.type === 'input_file').length, 1);
  assert.equal(content.find(part => part.type === 'input_file').file_data, 'data:application/pdf;base64,' + syntheticManual().base64);
  assert.equal(content.find(part => part.type === 'input_file').file_url, undefined);
  assert.equal(JSON.parse(content[0].text).product, undefined);
});

test('PDF-only product extraction does not invent missing identity or choose one model from a combined manual', async () => {
  const combined = { ...product, modelNumbers: ['SV21', 'SV20', 'SV20'] };
  assert.equal(productFromUploadedManual(combined).modelNumber, 'SV20 / SV21');
  assert.deepEqual(productFromUploadedManual({ ...combined, modelNumbers: ['SV20', 'SV21'] }), productFromUploadedManual(combined));
  for (const invalid of [undefined, { ...product, manufacturer: null }, { ...product, productName: '' },
    { ...product, modelNumbers: ['x\nforged'] }, { ...product, modelNumbers: ['x'.repeat(121)] }, { ...product, category: 'invented_category' }]) {
    const input = automatic(); let calls = 0;
    const result = await analyzeUploadedManual(input, { analyzeUploaded: async () => { calls++; return { value: { product: invalid, tasks: [task(input.manual)], providerNoResult: true } }; } });
    assert.equal(calls, 1); assert.equal(result.code, 'ANALYSIS_FAILED'); assert.equal(result.product, undefined);
    assert.doesNotMatch(result.message, /入力/);
  }
});

test('a manual with a maker and product but no model produces a verified null model without another analysis', async () => {
  const input = automatic();
  const reported = { manufacturer: 'Vita-Mix Corporation', productName: 'Vitamix TurboBlend VS', modelNumbers: [], category: 'other_appliance' };
  let calls = 0;
  const output = await analyzeUploadedManual(input, { analyzeUploaded: async () => {
    calls++;
    return { value: { product: reported, tasks: [task(input.manual)] } };
  } });
  assert.equal(calls, 1);
  assert.equal(output.status, 'verified');
  assert.equal(output.product.modelNumber, null);
  assert.equal(output.analysis.model, null);
  assert.equal(isVerifiedApplianceAnalysis(output.analysis, reported.manufacturer), true);
  assert.equal(productFromUploadedManual(reported, output.product).modelNumber, null);
  assert.equal(productFromUploadedManual({ ...reported, productName: 'Another appliance' }, output.product), null);
  assert.equal(productFromUploadedManual(reported, { ...output.product, modelNumber: 'Known' }), null);
});

test('automatic reanalysis validates PDF identity before preserving a saved name and never overwrites another product', async () => {
  const expected = { manufacturer: 'ダイソン', productName: '保存した元の製品名', modelNumber: 'SV20' };
  const request = { ...automatic(), ...expected };
  const output = async actual => analyzeUploadedManual(request, { analyzeUploaded: async () => ({ value: { product: actual, tasks: [task(request.manual)] } }) });
  assert.deepEqual((await output(product)).product, { ...expected, category: 'vacuum_cleaner' });
  assert.deepEqual((await output({ ...product, category: null })).product, expected, 'unknown kind does not invent a type');
  assert.equal((await output({ ...product, modelNumbers: ['OTHER'] })).code, 'ANALYSIS_FAILED');
  assert.equal((await output({ ...product, manufacturer: '別メーカー' })).code, 'ANALYSIS_FAILED');
});

const contentPrompt = request => request.input.flatMap(message => typeof message.content === 'string' ? [message.content]
  : message.content.filter(part => part.type === 'input_text').map(part => part.text)).join('\n');
test('PDF appliance-kind schema uses the same stable categories as the app without requesting another analysis', () => {
  assert.deepEqual([...UPLOADED_PRODUCT_CATEGORIES].sort(), applianceCategoryOptions.map(option => option.value).sort());
  assert.equal(productFromUploadedManual({ ...product, category: null }).category, undefined);
  assert.equal(productFromUploadedManual({ ...product, category: 'washing_machine' }).category, 'washing_machine');
});

test('PDF-only encrypted queue input preserves its identification mode and cannot share a legacy cache identity', () => {
  const input = automatic(); const requestKey = analysisRequestKey(input); const keys = syntheticAnalysisQueueKeys();
  const context = { owner: 'synthetic-owner', jobId: publicKey('pdf-only'), requestDigest: publicKey(requestKey) };
  const prepared = prepareAnalysisQueueInput(input, requestKey, keys, context);
  assert.deepEqual(decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, keys, context), input);
  const legacy = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', manual: input.manual };
  assert.notEqual(analysisRequestKey({ ...legacy, identifyFromManual: true }), analysisRequestKey(legacy));
  assert.throws(() => decodeAnalysisQueueInput(prepared.manifest, prepared.chunks, keys, { ...context, requestDigest: publicKey(analysisRequestKey(legacy)) }));
});

test('PDF-only HTTP admission cold worker retries and received product form one paid job with no typed identity', async t => {
  const f = publicStoreFixture(); let paidCalls = 0;
  const principal = { uid: 'synthetic-pdf-owner', anonymous: false, deviceId: publicKey('pdf-device'), installationId: 'synthetic-installation-0001' };
  const access = createPublicApiAccess({ store: f.store, verifyDevice: async () => ({ ...principal, reinstallProtection: 'verified' }),
    verifyIdToken: async () => ({ uid: principal.uid, firebase: { sign_in_provider: 'google.com' } }) });
  const server = createApplianceCareHttpServer({ publicAccess: access, dependencies: {} }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`; const body = JSON.stringify({ identifyFromManual: true, manual: syntheticManual() });
  const headers = { authorization: 'Bearer synthetic-pdf-test', 'content-type': 'application/json', 'x-idempotency-key': 'synthetic-pdf-only-admission' };
  await f.store.heartbeatAnalysisWorker();
  const start = async () => { const response = await fetch(url + '/api/appliance-care/jobs', { method: 'POST', headers, body }); assert.equal(response.status, 202); return response.json(); };
  const admission = await start(); assert.equal((await start()).jobId, admission.jobId); assert.equal(paidCalls, 0);
  const outcome = await runAnalysisQueueBatch({ store: createFirestoreUsageStore({ firestore: f.firestore, analysisQueueKeys: f.analysisQueueKeys }), authorize: async () => {},
    createDependencies: () => ({ analyzeUploaded: async sent => {
      paidCalls++; assert.equal(JSON.parse(sent.input[1].content[0].text).product, undefined);
      return { value: { product, tasks: [task(automatic().manual)] } };
    } }) });
  assert.equal(outcome.settled, 1); assert.equal(paidCalls, 1);
  const finished = await (await fetch(url + '/api/appliance-care/jobs/' + admission.jobId, { headers })).json();
  assert.equal(finished.done, true); assert.equal(finished.result.status, 'verified'); assert.equal(finished.result.product.modelNumber, 'SV20');
  assert.equal((await f.store.usage(principal)).used, 1);
  assert.equal((await start()).jobId, admission.jobId); assert.equal(paidCalls, 1);
  assert.equal([...f.records.keys()].some(path => path.includes('/analysisInputChunks/')), false);
});
