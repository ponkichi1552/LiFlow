import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { syntheticPdf } from './helpers/synthetic-pdf.mjs';
import { verifyManualContent } from '../src/features/appliance-care/manual-document.ts';
import { storeApplianceManualInside } from '../src/platform/storage/appliance-manual-storage.ts';
import { planReviewedApplianceSave } from '../src/features/appliance-care/persistence-policy.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readApplianceManual } = await import('../src/platform/storage/appliance-manuals.ts');
const product = { manufacturer: 'Example', productName: 'Cleaner', modelNumber: 'M1', category: '掃除機', manualUrl: 'https://example.invalid/manual.pdf' };
const task = name => ({ name, recommendedIntervalDays: 30, steps: ['clean'], tools: [], safetyCautions: [], evidence: [{ url: product.manualUrl }] });
const plan = (tasks, allChores) => planReviewedApplianceSave({ householdId: 'local-household', applianceId: 'appliance', now: '2026-11-07T00:00:00Z', product,
  analysis: { manufacturer: product.manufacturer, model: product.modelNumber, tasks, requiresUserReview: true, analyzedAt: '2026-11-07T00:00:00Z' },
  approvedTasks: tasks.map(task => ({ task })), allChores, newChoreId: name => `new-${name}` });

test('audit50 saving a verified PDF again repairs a corrupt retained row instead of silently preserving unreadable bytes', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const content = syntheticPdf().toString('base64'); const document = verifyManualContent(content);
  await storeApplianceManualInside(h.database, content, document.sha256);
  await h.database.runAsync('UPDATE appliance_manual_documents SET content_base64=? WHERE sha256=?', Buffer.from('damaged').toString('base64'), document.sha256);
  await assert.rejects(readApplianceManual(h.database, document.sha256));
  await storeApplianceManualInside(h.database, content, document.sha256);
  assert.equal(await readApplianceManual(h.database, document.sha256), content);
  await assert.rejects(storeApplianceManualInside(h.database, Buffer.from('tampered').toString('base64'), document.sha256));
  assert.equal(await readApplianceManual(h.database, document.sha256), content);
});

test('audit50 unchanged PDF reads use a content free SQLite revision fence instead of retransferring the whole document', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const bytes = Buffer.concat([syntheticPdf(), Buffer.alloc(1024 * 1024, 32)]); const content = bytes.toString('base64'); const { sha256 } = verifyManualContent(content);
  await storeApplianceManualInside(h.database, content, sha256);
  let transported = 0; const get = h.database.getFirstAsync;
  h.database.getFirstAsync = async (...args) => { const row = await get(...args); transported += row?.content_base64?.length ?? 0; return row; };
  for (let n = 0; n < 12; n++) assert.equal(await readApplianceManual(h.database, sha256), content);
  assert.ok(transported <= content.length, `PDF characters over the native bridge: ${transported}`);
  h.connection.prepare('UPDATE appliance_manual_documents SET content_base64=? WHERE sha256=?').run('bad-base64', sha256);
  await assert.rejects(readApplianceManual(h.database, sha256), 'a local SQL change invalidates the verified document cache');
});

test('audit50 a forty task review indexes duplicate names instead of rebuilding and searching one thousand unrelated definitions per task', () => {
  let reads = 0;
  const existing = Array.from({ length: 1000 }, (_, n) => ({ id: `unrelated-${n}`, get name() { reads++; return `unrelated-${n}`; } }));
  const result = plan(Array.from({ length: 40 }, (_, n) => task(`task-${n}`)), existing);
  assert.equal(result.definitions.length, 40); assert.equal(result.result.scheduledTaskCount, 40);
  assert.ok(reads <= 2000, `existing chore name lookups: ${reads}`);
});

test('audit50 an AI task gaining the appliance prefix retains its existing chore and overrides instead of retiring it as a duplicate', () => {
  const original = plan([task('フィルターを洗う')], []).definitions[0];
  const existing = { ...original, id: 'saved-filter', userIntervalDays: 45, recommendedCycleDays: 45, load: 'heavy', enabled: true };
  const result = plan([task('掃除機のフィルターを洗う')], [existing]);
  assert.equal(result.result.scheduledTaskCount, 1); assert.equal(result.result.duplicateTaskCount, 0);
  assert.equal(result.definitions.length, 1); assert.equal(result.definitions[0].id, 'saved-filter');
  assert.equal(result.definitions[0].userIntervalDays, 45); assert.equal(result.definitions[0].enabled, true);
  assert.equal(result.definitions[0].applianceTaskName, '掃除機のフィルターを洗う');
});

test('audit50 another SQLite connection invalidates verified manual content before cached bytes can be returned', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'liflow-manual-fence-')); const h = createDatabase(join(dir, 'manual.db')); let other;
  t.after(() => { other?.connection.close(); h.connection.close(); rmSync(dir, { recursive: true }); });
  await initializeLocalDatabase(h.database); const content = syntheticPdf().toString('base64'); const { sha256 } = verifyManualContent(content);
  await storeApplianceManualInside(h.database, content, sha256); assert.equal(await readApplianceManual(h.database, sha256), content);
  other = createDatabase(join(dir, 'manual.db'));
  other.connection.prepare('UPDATE appliance_manual_documents SET content_base64=? WHERE sha256=?').run('damaged externally', sha256);
  await assert.rejects(readApplianceManual(h.database, sha256));
  await storeApplianceManualInside(other.database, content, sha256); assert.equal(await readApplianceManual(h.database, sha256), content);
});
