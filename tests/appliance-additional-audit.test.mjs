import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { syntheticPdf } from './helpers/synthetic-pdf.mjs';
import { verifyManualContent } from '../src/features/appliance-care/manual-document.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { retainSharedApplianceCopies } = await import('../src/platform/storage/appliance-manuals.ts');

test('unchanged personal PDF reads reuse verified bytes but still reject changed stored content', async () => {
  let content = syntheticPdf().toString('base64'), verifications = 0;
  const digest = verifyManualContent(content).sha256;
  const { readApplianceManual } = loadNativeModule('src/platform/storage/appliance-manuals.ts', {
    '../../features/appliance-care/manual-document.ts': { verifyManualContent(...args) { verifications++; return verifyManualContent(...args); } },
    '../../features/appliance-care/official-url.ts': { applianceManufacturerIdentity: value => value },
    '../../features/sharing/crypto.ts': { sharedDocumentDigest },
    './repository.ts': { withPlannerDatabaseOperation: (_db, work) => work() },
    './isolated-transaction.ts': {}, './appliance-manual-storage.ts': {},
  });
  const db = { getFirstAsync: async () => ({ content_base64: content }) };
  for (let n = 0; n < 20; n++) assert.equal(await readApplianceManual(db, digest), content);
  assert.equal(verifications, 1);
  content = Buffer.from('%PDF-corrupt data'.repeat(10)).toString('base64');
  await assert.rejects(readApplianceManual(db, digest));
});

test('batch retained-appliance matching normalizes existing product identities once instead of once for every incoming appliance', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const values = Array.from({ length: 30 }, (_, n) => ({ id: `device-${n}`, householdId: 'shared:group', manufacturer: 'Example', productName: `P${n}`, modelNumber: `QA${n}`,
    displayName: `P${n}`, analysis: { tasks: [], analyzedAt: '2026-11-07T00:00Z' }, officialManualUrl: 'https://example.invalid/manual.pdf', createdAt: '2026-11-07T00:00Z', updatedAt: '2026-11-07T00:00Z' }));
  for (const appliance of values) await h.database.runAsync(`INSERT INTO appliances(id,household_id,manufacturer,product_name,model_number,display_name,official_manual_url,analysis_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    appliance.id, 'local-household', appliance.manufacturer, appliance.productName, appliance.modelNumber, appliance.displayName, appliance.officialManualUrl, JSON.stringify(appliance.analysis), appliance.createdAt, appliance.updatedAt);
  const original = String.prototype.normalize; let calls = 0;
  String.prototype.normalize = function (...args) { calls++; return original.apply(this, args); };
  try {
    await retainSharedApplianceCopies(h.database, 'group', values.map(appliance => ({ appliance, manual: null })), () => {});
    assert.equal(h.connection.prepare('SELECT count(*) n FROM appliances').get().n, 30);
    assert.ok(calls < 300, `identity normalizations: ${calls}`);
  } finally { String.prototype.normalize = original; }
});

test('native retention retries a PDF when its final chunk arrives after appliance and manifest were already copied', async () => {
  let complete = false; const copies = []; let reads = 0;
  const ops = [{ operation_id: 'appliance', type: 'appliance' }, { operation_id: 'manifest', type: 'manualDocument' }];
  const appliance = { id: 'device', analysis: { manualSource: { sha256: 'a'.repeat(64) } } };
  const db = { getAllAsync: async (_sql, ...types) => ops.filter(row => types.includes(row.type)),
    getFirstAsync: async sql => sql.includes('sharing_snapshot_state') ? null : { accepted_ids_json: JSON.stringify(ops.map(row => row.operation_id)) } };
  const { createNativeApplianceRetention } = loadNativeModule('src/platform/sharing/appliance-retention.ts', {
    'expo-sqlite': { openDatabaseAsync: async () => ({ closeAsync: async () => {} }) },
    '../storage/repository': { initializeLocalDatabase: async () => {} },
    '../storage/appliance-manuals': { retainSharedApplianceCopies: async (_db, _group, value) => { copies.push(value[0].manual); return true; } },
    '../../features/sharing/v2/appliance-state': { readV2Appliance: () => ({ appliance }) },
    '../../features/sharing/v2/manual-documents': { readV2ManualDocument: () => complete ? 'verified-pdf' : null },
    '../../features/sharing/v2/view-point': { v2ReadPoint: () => ({}) },
    '../../features/appliance-care/library-changes': { notifyApplianceLibraryChanges() {} },
  });
  const retention = createNativeApplianceRetention({ database: db, repository: { scope: { groupId: 'group' }, readCurrent: async work => { reads++; return work({ archive: [{}], assessment: { view: { ofType: () => [{ entityId: 'device' }] } } }); } }, assertAccess() {} });
  await retention.refresh(); assert.deepEqual(copies, [null]);
  complete = true; ops.push({ operation_id: 'last-chunk', type: 'manualChunk' }); await retention.refresh();
  assert.deepEqual(copies, [null, 'verified-pdf']); assert.equal(reads, 2);
});

test('appliance registration submits the latest native text even before the controlled value repaints', async () => {
  const { screenHarness } = await import('./helpers/screen-harness.mjs');
  const calls = [];
  const screen = screenHarness('src/features/appliance-care/appliance-library.tsx', { exportName: 'ApplianceLibrary', props: {
    items: [], onOpen() {}, onAdd: (...args) => calls.push(args),
  } });
  try {
    await screen.press('家電を追加');
    const input = screen.nodes().find(node => node.props.accessibilityLabel === '家電の製品名');
    input.props.onChangeText('  V12 Detect Slim  '); input.props.onSubmitEditing(); await screen.flush();
    assert.deepEqual(calls, [['personal', 'V12 Detect Slim']]);
  } finally { screen.unmount(); }
});
