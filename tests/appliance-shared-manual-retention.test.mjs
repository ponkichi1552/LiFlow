import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { syntheticPdf, syntheticManual } from './helpers/synthetic-pdf.mjs';
import { applianceResult } from './helpers/sharing-v2-appliance.mjs';
import { fixture, seeds, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { prepareManualDocument, verifyManualContent, restoreManualDocument, validateManualChunk, decodeManualBytes, MAX_MANUAL_BYTES, MANUAL_CHUNK_BYTES } from '../src/features/appliance-care/manual-document.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { readV2ManualDocument } from '../src/features/sharing/v2/manual-documents.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { loadSharedFacts, loadSharedReplica, applySharingSnapshot, applyReceivedSharedFacts, readSharingCheckpoint, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { encryptSharedOperation, decryptAuthenticatedSharedOperation } from '../src/features/sharing/crypto.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
const { initializeLocalDatabase, loadPlannerSnapshot, saveReviewedApplianceCare } = await import('../src/platform/storage/repository.ts');
const { readApplianceManual, retainSharedApplianceCopies } = await import('../src/platform/storage/appliance-manuals.ts');

export function uploadedResult(bytes = syntheticPdf()) {
  const digest = createHash('sha256').update(bytes).digest('hex'); const result = applianceResult();
  const reference = `liflow-manual://sha256/${digest}`;
  result.officialSources = { manualUrl: reference }; result.analysis.manualSource = { kind: 'user_upload', sha256: digest };
  for (const task of result.analysis.tasks) task.evidence = [{ url: reference, pageOrSection: '1ページ' }];
  return { result, manual: { base64: bytes.toString('base64'), rightsConfirmed: true } };
}

test('local PDF identity validation preserves full-size and boundary bytes without requiring shared network chunks', () => {
  for (const size of [syntheticPdf().length, MANUAL_CHUNK_BYTES, MANUAL_CHUNK_BYTES + 1, MAX_MANUAL_BYTES]) {
    const bytes = Buffer.alloc(size, 0x5a); syntheticPdf().copy(bytes);
    const digest = createHash('sha256').update(bytes).digest('hex'); const encoded = bytes.toString('base64');
    const checked = verifyManualContent(encoded, digest);
    assert.equal(checked.sha256, digest); assert.equal(checked.byteLength, size);
    assert.deepEqual(checked.bytes, Uint8Array.from(bytes));
    assert.equal(prepareManualDocument(encoded, digest).document.sha256, digest);
    assert.throws(() => verifyManualContent(encoded, '0'.repeat(64)));
  }
  for (const encoded of ['AB==', 'https://attacker.invalid/manual', Buffer.from('not a PDF'.repeat(20)).toString('base64')]) {
    assert.throws(() => verifyManualContent(encoded));
  }
});
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const controller = device => { let n = 0; return createV2GroupController(device.repository, { makeId: () => `pdf-${device.options.userId}-${++n}`, now, sync: async () => {} }); };
async function receive(device, facts) {
  const checkpoint = await readSharingCheckpoint(device.database, groupId);
  await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, checkpoint.cursor, now().getTime(), device.repository.evidenceForServerReceipts(receiptsFor(facts)));
}

test('PDF binary encoding works on native runtimes without browser atob or btoa globals', () => {
  const before = { atob: Object.getOwnPropertyDescriptor(globalThis, 'atob'), btoa: Object.getOwnPropertyDescriptor(globalThis, 'btoa') };
  try {
    delete globalThis.atob; delete globalThis.btoa;
    const bytes = Buffer.concat([syntheticPdf(), Buffer.from(Array.from({ length: 256 }, (_, value) => value))]);
    const source = bytes.toString('base64'); const saved = prepareManualDocument(source);
    assert.deepEqual(decodeManualBytes(source), Uint8Array.from(bytes));
    assert.equal(restoreManualDocument(saved.document, digest => saved.chunks.find(chunk => chunk.sha256 === digest)), source);
  } finally { for (const name of ['atob', 'btoa']) if (before[name]) Object.defineProperty(globalThis, name, before[name]); }
});

test('saved PDFs validate canonical bytes bounded chunks the full digest and missing or tampered pieces before reuse', () => {
  const bytes = Buffer.concat([syntheticPdf(), Buffer.alloc(MANUAL_CHUNK_BYTES * 2, 0x5a)]); const { manual } = uploadedResult(bytes);
  const saved = prepareManualDocument(manual.base64); assert.equal(saved.chunks.length, 3);
  const read = id => saved.chunks.find(chunk => chunk.sha256 === id);
  assert.equal(restoreManualDocument(saved.document, read), manual.base64);
  assert.equal(restoreManualDocument(saved.document, () => undefined), null);
  assert.throws(() => restoreManualDocument({ ...saved.document, sha256: '0'.repeat(64) }, read));
  assert.throws(() => validateManualChunk({ ...saved.chunks[0], content: saved.chunks[1].content }));
  for (const bad of ['', 'YWJj\n', 'YWJj====', 'AB==', 'https://example.invalid/file.pdf', 'a'.repeat(Math.ceil(MAX_MANUAL_BYTES / 3) * 4 + 4)]) assert.throws(() => decodeManualBytes(bad));
  assert.throws(() => prepareManualDocument(Buffer.from('not a PDF'.repeat(10)).toString('base64')));
  assert.throws(() => prepareManualDocument(manual.base64, '0'.repeat(64)));
  const largest = Buffer.alloc(MAX_MANUAL_BYTES, 0x5a); syntheticPdf().copy(largest);
  const full = prepareManualDocument(largest.toString('base64'));
  assert.equal(full.chunks.length, 64); assert.equal(full.document.byteLength, MAX_MANUAL_BYTES);
  assert.equal(restoreManualDocument(full.document, id => full.chunks.find(chunk => chunk.sha256 === id)), largest.toString('base64'));
});

test('one appliance review atomically retains its PDF in the encrypted outbox and two devices restore the same result without another analysis', async () => {
  const base = await fixture({ schedulerVersion: 'liflow-shared-2-draft-42' }); const a = await base.device(); const b = await base.device('member', base.member);
  const personal = createDatabase(); const c = controller(a);
  try {
    await a.repository.commit(seeds());
    const bytes = Buffer.concat([syntheticPdf(), Buffer.alloc(MANUAL_CHUNK_BYTES + 100, 0x5a)]);
    const input = uploadedResult(bytes); const before = await c.readModel(range);
    assert.equal(before.manualStorageSupported, true); assert.equal(before.calendarSupported, true);
    const saved = await c.actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: input.result.analysis.tasks.map(task => task.name) });
    assert.equal(saved.operations.filter(op => op.entityType === 'appliance').length, 1);
    assert.equal(saved.operations.filter(op => op.entityType === 'manualDocument').length, 1);
    assert.ok(saved.operations.filter(op => op.entityType === 'manualChunk').length >= 2);
    const key = new Uint8Array(32).fill(9); const facts = await loadSharedFacts(a.database, groupId);
    const roundTrip = [];
    for (const fact of facts) {
      const envelope = await encryptSharedOperation(sharingTestCrypto, fact.operation, key, base.owner);
      assert.equal(JSON.stringify(envelope).includes(input.manual.base64), false);
      roundTrip.push(await decryptAuthenticatedSharedOperation(sharingTestCrypto, envelope, key, base.owner, groupId, envelope.keyVersion));
    }
    await receive(b, roundTrip.reverse()); await receive(b, facts);
    const state = await b.repository.readState(); const at = v2ReadPoint(state.assessment.view, state.archive.at(-1));
    assert.equal(state.assessment.rejected.length, 0);
    const pdf = readV2ManualDocument(state.assessment.view, at, input.result.analysis.manualSource.sha256);
    assert.equal(pdf, input.manual.base64);
    const model = await controller(b).readModel(range, { appliances: true, applianceId: saved.applianceId });
    assert.deepEqual(model.appliances.detail.appliance.analysis, input.result.analysis);
    assert.deepEqual((await c.readModel(range)).plan.occurrences, before.plan.occurrences, 'retaining an appliance must not silently enable its care tasks');
    const count = (await listSharingOutbox(a.database, groupId)).length;
    const retry = await c.actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: input.result.analysis.tasks.map(task => task.name) });
    assert.deepEqual(retry.operations, []); assert.equal((await listSharingOutbox(a.database, groupId)).length, count);
    await initializeLocalDatabase(personal.database);
    const old = await loadPlannerSnapshot(personal.database);
    await retainSharedApplianceCopies(personal.database, groupId, [{ appliance: model.appliances.detail.appliance, manual: pdf }], () => {});
    await retainSharedApplianceCopies(personal.database, groupId, [{ appliance: model.appliances.detail.appliance, manual: pdf }], () => {});
    const local = await loadPlannerSnapshot(personal.database);
    assert.equal(local.appliances.length, 1); assert.deepEqual(local.appliances[0].analysis, input.result.analysis);
    assert.deepEqual(local.chores, old.chores); assert.deepEqual(local.completions, old.completions);
    assert.equal(await readApplianceManual(personal.database, input.result.analysis.manualSource.sha256), input.manual.base64);
    // A later group deletion does not cascade into the independently retained personal library/PDF.
    await c.actions.deleteAppliance((await c.readModel(range, { appliances: true, applianceId: saved.applianceId })).appliances.detail.row.selection);
    assert.equal((await loadPlannerSnapshot(personal.database)).appliances.length, 1);
    assert.equal(await readApplianceManual(personal.database, input.result.analysis.manualSource.sha256), input.manual.base64);
  } finally { a.connection.close(); b.connection.close(); personal.connection.close(); }
});

test('missing wrong or unconsented PDFs roll back the complete shared review while original private uploads survive a failed save', async () => {
  const base = await fixture(); const a = await base.device(); const personal = createDatabase(); const c = controller(a);
  try {
    await a.repository.commit(seeds()); const before = await loadSharedFacts(a.database, groupId); const input = uploadedResult();
    for (const extra of [{ manual: undefined }, { manual: { ...input.manual, rightsConfirmed: false } }, { manual: { ...input.manual, base64: syntheticPdf(2).toString('base64') } }]) {
      await assert.rejects(c.actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: [], ...extra }));
      assert.deepEqual(await loadSharedFacts(a.database, groupId), before);
    }
    await initializeLocalDatabase(personal.database);
    const product = { ...input.result.product, manualUrl: input.result.officialSources.manualUrl };
    await assert.rejects(saveReviewedApplianceCare(personal.database, product, input.result.analysis, [], { ...input.manual, base64: syntheticPdf(2).toString('base64') }));
    assert.equal(personal.connection.prepare('SELECT count(*) n FROM appliance_manual_documents').get().n, 0);
    assert.equal(personal.connection.prepare('SELECT count(*) n FROM appliances').get().n, 0);
    await saveReviewedApplianceCare(personal.database, product, input.result.analysis, [], input.manual);
    assert.equal(await readApplianceManual(personal.database, input.result.analysis.manualSource.sha256), input.manual.base64);
  } finally { a.connection.close(); personal.connection.close(); }
});

test('a changed account or a foreign group cannot retain shared PDFs or overwrite personal schedules and historical settings', async () => {
  const personal = createDatabase();
  try {
    await initializeLocalDatabase(personal.database); const input = uploadedResult();
    const appliance = { id: 'shared-appliance', householdId: `shared:${groupId}`, ...input.result.product, displayName: '共有の掃除機',
      officialManualUrl: input.result.officialSources.manualUrl, analysis: input.result.analysis, createdAt: now().toISOString(), updatedAt: now().toISOString() };
    let checks = 0;
    await assert.rejects(retainSharedApplianceCopies(personal.database, groupId, [{ appliance, manual: input.manual.base64 }], () => { if (++checks >= 2) throw new Error('account changed'); }));
    assert.equal(personal.connection.prepare('SELECT count(*) n FROM appliances').get().n, 0);
    assert.equal(personal.connection.prepare('SELECT count(*) n FROM appliance_manual_documents').get().n, 0);
    await assert.rejects(retainSharedApplianceCopies(personal.database, 'foreign', [{ appliance, manual: input.manual.base64 }], () => {}));
    assert.equal(personal.connection.prepare('SELECT count(*) n FROM appliances').get().n, 0);
  } finally { personal.connection.close(); }
});

test('retained appliance metadata refreshes the cached library without recalculating schedules or altering custom personal names', async () => {
  const h = createDatabase();
  try {
    const repository = await import('../src/platform/storage/repository.ts');
    await initializeLocalDatabase(h.database); const input = uploadedResult();
    const saved = await saveReviewedApplianceCare(h.database, { ...input.result.product, manualUrl: input.result.officialSources.manualUrl }, input.result.analysis, [], input.manual);
    await h.database.runAsync('UPDATE appliances SET display_name=? WHERE id=?', '居間の掃除機', saved.applianceId);
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: { region: '横浜市', displayName: '横浜市', latitude: 35.44, longitude: 139.64 } });
    let evaluations = 0; const optimize = async input => { evaluations++; return { schedule: input.schedule, outcome: 'current', adjustmentCount: 0 }; };
    const previous = await repository.applyWeatherToPlannerSnapshot(h.database, await loadPlannerSnapshot(h.database), () => true, optimize);
    const appliance = { ...previous.appliances[0], id: 'shared-copy', householdId: `shared:${groupId}`, displayName: 'グループの掃除機',
      productName: '共有側の製品情報', updatedAt: new Date().toISOString() };
    assert.equal(await retainSharedApplianceCopies(h.database, groupId, [{ appliance, manual: input.manual.base64 }], () => {}), true);
    assert.equal(await retainSharedApplianceCopies(h.database, groupId, [{ appliance, manual: input.manual.base64 }], () => {}), false);
    await repository.refreshCachedApplianceLibrary(h.database);
    const cached = repository.readCachedPlannerSnapshot(h.database);
    assert.equal(cached.appliances.length, 1); assert.equal(cached.appliances[0].id, saved.applianceId);
    assert.equal(cached.appliances[0].displayName, '居間の掃除機'); assert.equal(cached.appliances[0].productName, '共有側の製品情報');
    assert.equal(cached.scheduleEntries, previous.scheduleEntries); assert.equal(cached.chores, previous.chores);
    assert.equal(cached.completions, previous.completions); assert.equal(cached.states, previous.states);
    const afterWeather = await repository.applyWeatherToPlannerSnapshot(h.database, cached, () => true, optimize);
    assert.equal(afterWeather.appliances, cached.appliances); assert.equal(afterWeather.appliances[0].productName, '共有側の製品情報');
    assert.equal(evaluations, 1, 'metadata refresh cannot re-request weather or prolong its expiry');
    assert.equal(afterWeather.scheduleEntries, previous.scheduleEntries);
  } finally { h.connection.close(); }
});

for (const override of [undefined, 60]) test(`personal copied appliance details show the registered ${override ?? 30} day cadence separately from a newer ninety day analysis`, async t => {
  const repository = await import('../src/platform/storage/repository.ts');
  const { screenHarness } = await import('./helpers/screen-harness.mjs');
  const { generateHouseworkSchedule } = await import('../src/domain/scheduling/engine.ts');
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); const input = uploadedResult();
  const saved = await saveReviewedApplianceCare(h.database, { ...input.result.product, manualUrl: input.result.officialSources.manualUrl }, input.result.analysis,
    [{ task: input.result.analysis.tasks[0], ...(override ? { userIntervalDays: override } : {}) }], input.manual);
  const before = await loadPlannerSnapshot(h.database); const appliance = { ...before.appliances[0], id: 'shared-copy', householdId: `shared:${groupId}`,
    analysis: { ...before.appliances[0].analysis, tasks: before.appliances[0].analysis.tasks.map((task, index) => index ? task : { ...task, recommendedIntervalDays: 90 }) } };
  await retainSharedApplianceCopies(h.database, groupId, [{ appliance, manual: input.manual.base64 }], () => {});
  const context = await repository.loadApplianceCareReviewContext(h.database, saved.applianceId); const chore = context.chores[0];
  const screen = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'MaintenanceTaskCard', props: { task: context.appliance.analysis.tasks[0], chore, frequencyMode: context.frequencyMode, index: 0 } });
  assert.ok(screen.text().includes('メーカー推奨：90日')); assert.ok(screen.text().includes(`予定周期：${override ?? 30}日`));
  const entries = generateHouseworkSchedule({ chores: [chore], states: [{ choreId: chore.id, lastCompletedDate: '2026-10-01' }], completions: [], dependencies: [], assignments: [],
    settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 2 } }, today: '2026-10-02', from: '2026-10-02', through: '2026-12-31' });
  assert.equal(entries[0].cycleBaseDate, override ? '2026-11-30' : '2026-10-31');
  assert.equal(h.connection.prepare('SELECT count(*) AS n FROM chore_completions').get().n, 0);
});

test('a PDF received after unchanged appliance metadata is retained without duplicating the product or private chores', async () => {
  const h = createDatabase();
  try {
    await initializeLocalDatabase(h.database); const input = uploadedResult();
    const appliance = { id: 'historical-shared-appliance', householdId: `shared:${groupId}`, ...input.result.product,
      displayName: '保存済みの掃除機', officialManualUrl: input.result.officialSources.manualUrl, analysis: input.result.analysis,
      createdAt: now().toISOString(), updatedAt: now().toISOString() };
    await retainSharedApplianceCopies(h.database, groupId, [{ appliance, manual: null }], () => {});
    const before = await loadPlannerSnapshot(h.database);
    assert.equal(await readApplianceManual(h.database, input.result.analysis.manualSource.sha256), null);
    assert.equal(await retainSharedApplianceCopies(h.database, groupId, [{ appliance, manual: input.manual.base64 }], () => {}), true);
    assert.equal(await readApplianceManual(h.database, input.result.analysis.manualSource.sha256), input.manual.base64);
    assert.equal(await retainSharedApplianceCopies(h.database, groupId, [{ appliance, manual: input.manual.base64 }], () => {}), false);
    const after = await loadPlannerSnapshot(h.database);
    assert.deepEqual(after.appliances, before.appliances); assert.deepEqual(after.chores, before.chores);
    assert.deepEqual(after.completions, before.completions);
  } finally { h.connection.close(); }
});

test('native appliance retention coalesces copies skips ordinary chore changes and rejects another account without opening private storage', async () => {
  const base = await fixture(); const owner = await base.device(); const personal = createDatabase();
  let opened = 0; let closed = 0; let notices = 0; let allowed = true;
  try {
    await owner.repository.commit(seeds());
    const module = loadNativeModule('src/platform/sharing/appliance-retention.ts', {
      'expo-sqlite': { openDatabaseAsync: async name => { assert.equal(name, 'housework.db'); opened++; return { ...personal.database, closeAsync: async () => { closed++; } }; } },
      '../storage/repository': { initializeLocalDatabase }, '../storage/appliance-manuals': { retainSharedApplianceCopies },
      '../../features/sharing/v2/appliance-state': await import('../src/features/sharing/v2/appliance-state.ts'),
      '../../features/sharing/v2/manual-documents': { readV2ManualDocument }, '../../features/sharing/v2/view-point': { v2ReadPoint },
      '../../features/appliance-care/library-changes': { notifyApplianceLibraryChanges: () => { notices++; } },
    });
    const retention = module.createNativeApplianceRetention({ database: owner.database, repository: owner.repository,
      assertAccess: () => { if (!allowed) throw new Error('account changed'); } });
    await retention.refresh(); assert.equal(opened, 0, 'ordinary chores never initialize a private appliance copy');
    const input = uploadedResult(); const c = controller(owner);
    await c.actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: [] });
    await Promise.all([retention.refresh(), retention.refresh()]);
    assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(notices, 1);
    assert.equal(await readApplianceManual(personal.database, input.result.analysis.manualSource.sha256), input.manual.base64);
    await retention.refresh(); assert.equal(opened, 1); assert.equal(notices, 1);
    allowed = false; await assert.rejects(retention.refresh(), /account changed/); assert.equal(opened, 1);
  } finally { owner.connection.close(); personal.connection.close(); }
});

test('a committed appliance review reports a retryable personal-copy failure without replaying the signed save or another paid analysis', async () => {
  const base = await fixture(); const owner = await base.device(); const personal = createDatabase();
  let writable = true; let failOpen = true; let opened = 0; let reviewed = 0;
  try {
    await owner.repository.commit(seeds()); const input = uploadedResult(); const c = controller(owner);
    const guard = () => { if (!writable) throw new Error('account changed'); };
    const module = loadNativeModule('src/platform/sharing/appliance-retention.ts', {
      'expo-sqlite': { openDatabaseAsync: async () => { opened++; if (failOpen) throw new Error('private storage unavailable'); return { ...personal.database, closeAsync: async () => {} }; } },
      '../storage/repository': { initializeLocalDatabase }, '../storage/appliance-manuals': { retainSharedApplianceCopies },
      '../../features/sharing/v2/appliance-state': await import('../src/features/sharing/v2/appliance-state.ts'),
      '../../features/sharing/v2/manual-documents': { readV2ManualDocument }, '../../features/sharing/v2/view-point': { v2ReadPoint },
      '../../features/appliance-care/library-changes': { notifyApplianceLibraryChanges() {} },
    });
    const retention = module.createNativeApplianceRetention({ database: owner.database, repository: owner.repository, assertAccess: guard });
    const saved = await module.reviewWithPersonalApplianceRetention(async () => { reviewed++; return c.actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: [] }); }, retention, guard);
    assert.equal(saved.personalRetentionPending, true); assert.ok(saved.applianceId);
    assert.equal((await c.readModel(range, { appliances: true })).appliances.rows.length, 1);
    const pending = await listSharingOutbox(owner.database, groupId);
    failOpen = false; await retention.refresh();
    assert.equal(await readApplianceManual(personal.database, input.result.analysis.manualSource.sha256), input.manual.base64);
    assert.equal(reviewed, 1); assert.equal(opened, 2); assert.deepEqual(await listSharingOutbox(owner.database, groupId), pending);
    await assert.rejects(module.reviewWithPersonalApplianceRetention(async () => { throw new Error('before shared commit'); }, retention, guard), /before shared commit/);
    assert.equal(opened, 2);
    const ordinary = { operations: [], applianceId: saved.applianceId, createdChoreIds: [], preservedTaskNames: [] };
    await assert.rejects(module.reviewWithPersonalApplianceRetention(async () => ordinary, { refresh: async () => { writable = false; throw new Error('account changed'); } }, guard), /account changed/);
  } finally { owner.connection.close(); personal.connection.close(); }
});

test('a new device retains the appliance and PDF from a verified snapshot without requiring another event or analysis', async () => {
  const base = await fixture(); const owner = await base.device(); const restored = await base.device('member', base.member); const personal = createDatabase();
  let opened = 0;
  try {
    await owner.repository.commit(seeds()); const input = uploadedResult(Buffer.concat([syntheticPdf(), Buffer.alloc(MANUAL_CHUNK_BYTES, 0x5a)]));
    await controller(owner).actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: [] });
    const facts = await loadSharedFacts(owner.database, groupId); const replica = await loadSharedReplica(owner.database, groupId);
    const key = new Uint8Array(32).fill(8); const resolve = (userId, deviceId, version) => sharedAuthorIdentity(base.archive[version - 1], userId, deviceId, version);
    const sealed = await createEncryptedSharedSnapshot(sharingTestCrypto, replica, facts, base.archive.at(-1), base.owner, key, 'pdf-device-restore', facts.length, resolve);
    const snapshot = await openEncryptedSharedSnapshot(sharingTestCrypto, sealed, key, base.archive.at(-1), resolve);
    await applySharingSnapshot(restored.database, groupId, snapshot, restored.repository.project, null, now().getTime(), restored.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal(restored.connection.prepare('SELECT count(*) n FROM sharing_operations').get().n, 0);
    const module = loadNativeModule('src/platform/sharing/appliance-retention.ts', {
      'expo-sqlite': { openDatabaseAsync: async () => { opened++; return { ...personal.database, closeAsync: async () => {} }; } },
      '../storage/repository': { initializeLocalDatabase }, '../storage/appliance-manuals': { retainSharedApplianceCopies },
      '../../features/sharing/v2/appliance-state': await import('../src/features/sharing/v2/appliance-state.ts'),
      '../../features/sharing/v2/manual-documents': { readV2ManualDocument }, '../../features/sharing/v2/view-point': { v2ReadPoint },
      '../../features/appliance-care/library-changes': { notifyApplianceLibraryChanges() {} },
    });
    const retention = module.createNativeApplianceRetention({ database: restored.database, repository: restored.repository, assertAccess() {} });
    await retention.refresh(); assert.equal(opened, 1);
    assert.equal(await readApplianceManual(personal.database, input.result.analysis.manualSource.sha256), input.manual.base64);
    assert.equal((await loadPlannerSnapshot(personal.database)).appliances.length, 1);
    await retention.refresh(); assert.equal(opened, 1, 'an unchanged snapshot must not repeatedly copy its PDF');
  } finally { owner.connection.close(); restored.connection.close(); personal.connection.close(); }
});
