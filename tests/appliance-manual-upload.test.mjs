import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticPdf, syntheticManual } from './helpers/synthetic-pdf.mjs';
import { decodeUploadedManual, inspectUploadedManual, analyzeUploadedManual, MAX_MANUAL_BYTES } from '../server/appliance-care-api/src/uploaded-manual.mjs';
import { publicKey } from '../server/appliance-care-api/src/public-access.mjs';
import { isVerifiedApplianceAnalysis } from '../src/features/appliance-care/analysis-validation.ts';
import { matchesUploadedManual } from '../src/features/appliance-care/manual-source.ts';
import { normalizeV2ReviewedAppliance } from '../src/features/sharing/v2/appliance-state.ts';
import { createPublicAnalysisDependencies } from '../server/appliance-care-api/src/public-analysis.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';

test('manual upload rejects URLs paths missing consent forged hashes oversized malformed and password-like documents before paid analysis', async () => {
  for (const input of [null, { url: 'https://attacker.invalid/manual.pdf' }, { path: '/etc/passwd' },
    { ...syntheticManual(), rightsConfirmed: false }, { base64: 'a'.repeat(Math.ceil(MAX_MANUAL_BYTES / 3) * 4 + 4), rightsConfirmed: true },
    { base64: 'JVBERi0xLjQKinvalid===', rightsConfirmed: true }, { base64: Buffer.from('a'.repeat(100)).toString('base64'), rightsConfirmed: true }]) {
    assert.throws(() => decodeUploadedManual(input), e => e.code === 'INVALID_MANUAL');
  }
  const manual = decodeUploadedManual({ ...syntheticManual(), sha256: '0'.repeat(64), remaining: 5 });
  assert.equal(manual.reference, `liflow-manual://sha256/${publicKey(syntheticPdf())}`);
  assert.equal(await inspectUploadedManual(manual.bytes), 1);
  await assert.rejects(inspectUploadedManual(syntheticPdf(101)), e => e.code === 'INVALID_MANUAL');
  await assert.rejects(inspectUploadedManual(Buffer.from('%PDF-1.7\n' + 'invalid encrypted document'.repeat(3) + '\n%%EOF')), e => e.code === 'INVALID_MANUAL');
});

test('manual base64 validation accepts the full upload limit without recursive regular-expression overflow', () => {
  const pdf = syntheticPdf();
  const bytes = Buffer.concat([pdf.subarray(0, -6), Buffer.alloc(MAX_MANUAL_BYTES - pdf.length, 32), pdf.subarray(-6)]);
  const input = { base64: bytes.toString('base64'), rightsConfirmed: true };
  assert.deepEqual(decodeUploadedManual(input).bytes, bytes);
  for (const base64 of [input.base64.slice(0, -1), input.base64.slice(0, -8) + '=AAA====',
    'JVBERi0xLjQK' + 'A'.repeat(120000) + '?===', input.base64.slice(0, 1000000) + '\n' + input.base64.slice(1000001)]) {
    assert.throws(() => decodeUploadedManual({ base64, rightsConfirmed: true }), e => e.code === 'INVALID_MANUAL');
  }
});

test('an inspection deadline is a retryable server failure and never a permanent invalid-PDF verdict or a cached rejection', async t => {
  const bytes = syntheticPdf(2);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const checking = inspectUploadedManual(bytes);
    const rejected = assert.rejects(checking, error => error.status === 503 && error.code === 'TEMPORARY_NETWORK_ERROR');
    t.mock.timers.tick(5000);
    await rejected;
  } finally { t.mock.timers.reset(); }
  assert.equal(await inspectUploadedManual(bytes), 2, 'a subsequent attempt inspects the same valid document normally');
});

test('uploaded analysis sends only submitted bytes with no search or URL fetch and validates exact digest-only provenance', async () => {
  const manual = decodeUploadedManual(syntheticManual()); let sent; let calls = 0;
  const task = { name: 'フィルターのお手入れ', recommendedIntervalDays: null, recommendedConditions: ['汚れが目立った時'],
    steps: ['電源を切ってから汚れを落とす'], tools: [], safetyCautions: ['通電したまま作業しない'], estimatedMinutes: null,
    evidence: [{ pageOrSection: '1ページ' }] };
  const request = { manufacturer: '検査メーカー', productName: '検査製品', modelNumber: 'QA', manual };
  const result = await analyzeUploadedManual(request, { analyzeUploaded: async value => { calls++; sent = value; return { value: { tasks: [task] } }; } });
  assert.equal(calls, 1); assert.equal(result.status, 'verified'); assert.equal(sent.tools, undefined);
  const file = sent.input[1].content.find(item => item.type === 'input_file');
  assert.equal(file.file_data, 'data:application/pdf;base64,' + syntheticManual().base64); assert.equal(file.file_url, undefined);
  assert.deepEqual(sent.schema.properties.tasks.items.properties.evidence.items.required, ['pageOrSection']);
  assert.equal(sent.schema.properties.tasks.items.properties.steps.minItems, 1);
  assert.equal(JSON.stringify(sent.input).includes(manual.reference), false);
  assert.deepEqual(result.analysis.tasks[0].evidence, [{ url: manual.reference, pageOrSection: '1ページ' }]);
  assert.equal(isVerifiedApplianceAnalysis(result.analysis, request.manufacturer), true);
  assert.equal(matchesUploadedManual(result.officialSources.manualUrl, result.analysis), true);
  const saved = normalizeV2ReviewedAppliance({ ...result.product, displayName: '検査', officialManualUrl: result.officialSources.manualUrl,
    analysis: result.analysis, reviewed: true });
  assert.ok(saved); assert.equal(JSON.stringify(saved).includes(syntheticManual().base64), false, 'shared content never includes the original PDF');
  assert.equal(JSON.stringify(saved).includes('file_data'), false);
  const forged = structuredClone(result.analysis); forged.tasks[0].evidence[0].url = 'https://www.dyson.co.jp/fake.pdf';
  assert.equal(isVerifiedApplianceAnalysis(forged, request.manufacturer), false);
  const bad = await analyzeUploadedManual(request, { analyzeUploaded: async () => ({ value: { tasks: [{ ...task, evidence: [{ url: 'https://attacker.invalid/', pageOrSection: '1' }] }] } }) });
  assert.equal(bad.status, 'error'); assert.equal(bad.code, 'ANALYSIS_FAILED');
});

test('public paid analysis cannot enable search external file URLs or a second upstream call', async () => {
  let calls = 0;
  const deps = createPublicAnalysisDependencies(new AbortController().signal, { createAi: () => ({ createStructured: async () => { calls++; return { value: {} }; } }) });
  for (const request of [{ tools: [{ type: 'web_search' }], input: [] }, { input: [{ content: [{ type: 'input_file', file_url: 'https://attacker.invalid/' }] }] }]) {
    assert.throws(() => deps.analyzeUploaded(request));
  }
  assert.equal(calls, 0); await deps.analyzeUploaded({ input: [] }); await assert.rejects(deps.analyzeUploaded({ input: [] })); assert.equal(calls, 1);
});

for (const platform of ['ios', 'android']) test(`${platform} manual selection reads a PDF then deletes only its own copied cache file and cancellation sends nothing`, async () => {
  const events = [];
  let cancelled = false;
  let uri = 'file:///cache/selected.pdf';
  let bytes = syntheticPdf(100);
  let pages = 100;
  let hasNativeInspection = true;
  const api = loadNativeModule('src/features/appliance-care/manual-upload-input.tsx', {
    'react/jsx-runtime': {}, react: {}, 'react-native': {}, '../../components/planner-ui': {},
    'expo-document-picker': { getDocumentAsync: async options => { assert.deepEqual(options, { type: 'application/pdf', multiple: false, copyToCacheDirectory: true });
      return cancelled ? { canceled: true } : { canceled: false, assets: [{ uri, name: 'original.pdf' }] }; } },
    expo: { requireOptionalNativeModule: name => {
      assert.equal(name, 'LiFlowPdfInspection');
      return hasNativeInspection ? { async pageCount(path) { assert.equal(path, uri); events.push('inspect'); return pages; } } : null;
    } },
    'expo-file-system': { FileMode: { ReadOnly: 'r' }, Paths: { cache: { uri: 'file:///cache/' } }, File: class {
      constructor(uri) { this.uri = uri; } get size() { return bytes.length; } exists = true;
      open(mode) {
        assert.equal(mode, 'r');
        return { offset: 0, async readBytes(length) { return bytes.subarray(this.offset, this.offset + length); }, close() { events.push('close'); } };
      }
      async base64() { events.push('read'); return bytes.toString('base64'); } delete() { events.push(['delete', this.uri]); }
    } },
  });
  assert.deepEqual(await api.pickApplianceManual(), { name: 'original.pdf', base64: bytes.toString('base64') });
  assert.deepEqual(events.splice(0), ['close', 'inspect', 'read', ['delete', uri]]);
  cancelled = true;
  assert.equal(await api.pickApplianceManual(), null);
  assert.deepEqual(events, []);

  cancelled = false;
  for (const [count, message] of [[101, /100ページ/], [0, /開けません/], [null, /もう一度/]]) {
    pages = count;
    await assert.rejects(api.pickApplianceManual(), message);
    assert.deepEqual(events.splice(0), ['close', 'inspect', ['delete', uri]], 'a failed inspection never reads the upload body');
  }
  for (const malformed of [Buffer.alloc(128), syntheticPdf().subarray(0, -6)]) {
    bytes = malformed;
    await assert.rejects(api.pickApplianceManual(), /PDF形式/);
    assert.deepEqual(events.splice(0), ['close', ['delete', uri]]);
  }
  bytes = Buffer.alloc(MAX_MANUAL_BYTES + 1);
  await assert.rejects(api.pickApplianceManual(), /6MiB/);
  assert.deepEqual(events.splice(0), [['delete', uri]]);

  hasNativeInspection = false;
  uri = 'file:///documents/original.pdf';
  bytes = syntheticPdf();
  assert.ok(await api.pickApplianceManual());
  assert.deepEqual(events, ['close', 'read'], 'older app builds keep server-side page validation and never remove the source');
});

test('only an internal OpenAI no-result classification returns a non-consuming analysis error', async () => {
  const request = { manufacturer: '検査', productName: '合成', modelNumber: 'QA', manual: decodeUploadedManual(syntheticManual()) };
  const noResult = await analyzeUploadedManual(request, { analyzeUploaded: async () => { throw Object.assign(new Error('private detail'), { providerNoResult: true }); } });
  assert.equal(noResult.code, 'AI_SERVICE_NO_RESULT'); assert.equal(noResult.message.includes('private detail'), false);
  const badOutput = await analyzeUploadedManual(request, { analyzeUploaded: async () => ({ value: { tasks: [], providerNoResult: true } }) });
  assert.equal(badOutput.code, 'ANALYSIS_FAILED', 'PDF/model text cannot turn an invalid returned analysis into an authoritative refund');
});
