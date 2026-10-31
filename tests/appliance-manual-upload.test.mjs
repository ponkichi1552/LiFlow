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

test('uploaded analysis sends only submitted bytes with no search or URL fetch and validates exact digest-only provenance', async () => {
  const manual = decodeUploadedManual(syntheticManual()); let sent; let calls = 0;
  const task = { name: 'フィルターのお手入れ', recommendedIntervalDays: null, recommendedConditions: ['汚れが目立った時'],
    steps: ['電源を切ってから汚れを落とす'], tools: [], safetyCautions: ['通電したまま作業しない'], estimatedMinutes: null,
    evidence: [{ url: manual.reference, pageOrSection: '1ページ' }] };
  const request = { manufacturer: '検査メーカー', productName: '検査製品', modelNumber: 'QA', manual };
  const result = await analyzeUploadedManual(request, { analyzeUploaded: async value => { calls++; sent = value; return { value: { tasks: [task] } }; } });
  assert.equal(calls, 1); assert.equal(result.status, 'verified'); assert.equal(sent.tools, undefined);
  const file = sent.input[1].content.find(item => item.type === 'input_file');
  assert.equal(file.file_data, 'data:application/pdf;base64,' + syntheticManual().base64); assert.equal(file.file_url, undefined);
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
  const events = []; let cancelled = false; let tooLarge = false;
  const api = loadNativeModule('src/features/appliance-care/manual-upload-input.tsx', {
    'react/jsx-runtime': {}, react: {}, 'react-native': {}, '../../components/planner-ui': {},
    'expo-document-picker': { getDocumentAsync: async options => { assert.deepEqual(options, { type: 'application/pdf', multiple: false, copyToCacheDirectory: true });
      return cancelled ? { canceled: true } : { canceled: false, assets: [{ uri: 'file:///cache/selected.pdf', name: 'original.pdf' }] }; } },
    'expo-file-system': { Paths: { cache: { uri: 'file:///cache/' } }, File: class {
      constructor(uri) { this.uri = uri; } get size() { return tooLarge ? MAX_MANUAL_BYTES + 1 : 100; } exists = true;
      async base64() { events.push('read'); return 'synthetic-content'; } delete() { events.push(['delete', this.uri]); }
    } },
  });
  const selected = await api.pickApplianceManual(); assert.equal(selected.name, 'original.pdf');
  assert.deepEqual(events, ['read', ['delete', 'file:///cache/selected.pdf']]);
  cancelled = true; assert.equal(await api.pickApplianceManual(), null); assert.equal(events.length, 2);
  cancelled = false; tooLarge = true; await assert.rejects(api.pickApplianceManual(), /6MiB/); assert.equal(events.at(-1)[0], 'delete');
});

test('only an internal OpenAI no-result classification returns a non-consuming analysis error', async () => {
  const request = { manufacturer: '検査', productName: '合成', modelNumber: 'QA', manual: decodeUploadedManual(syntheticManual()) };
  const noResult = await analyzeUploadedManual(request, { analyzeUploaded: async () => { throw Object.assign(new Error('private detail'), { providerNoResult: true }); } });
  assert.equal(noResult.code, 'AI_SERVICE_NO_RESULT'); assert.equal(noResult.message.includes('private detail'), false);
  const badOutput = await analyzeUploadedManual(request, { analyzeUploaded: async () => ({ value: { tasks: [], providerNoResult: true } }) });
  assert.equal(badOutput.code, 'ANALYSIS_FAILED', 'PDF/model text cannot turn an invalid returned analysis into an authoritative refund');
});
