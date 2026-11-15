import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { fixture, seeds, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import * as eventModule from '../src/domain/calendar/events.ts';
import * as dateModule from '../src/domain/scheduling/local-date.ts';
import * as importFormatter from '../src/features/calendar/import-formatter.ts';
import { validateCustomRecurrence } from '../src/domain/calendar/recurrence.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { validateSharedOperation } from '../src/features/sharing/operations.ts';
import * as operationModule from '../src/features/sharing/operations.ts';
import * as rosterModule from '../src/features/sharing/roster.ts';
import * as cloudContract from '../src/features/sharing/cloud-contract.ts';
import { sharedDocumentDigest, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { V2_SCHEDULER_VERSION, supportsCalendarMonthDates, supportsSharedCalendar, supportsOneOffChores } from '../src/features/sharing/v2/payload-schema.ts';
import { CALENDAR_MONTH_DATES_UPGRADE_MESSAGE } from '../src/features/sharing/v2/calendar-compatibility.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { validateV2DeliveredAuthority } from '../src/features/sharing/v2/receiver-authority.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { createV2HistoryView } from '../src/features/sharing/v2/history-view.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { loadSharedFacts, listSharingOutbox, applyReceivedSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import { validatedPrivateBusyIntervals } from '../src/features/sharing/v2/private-availability.ts';
import { snapshotPrivateCalendarIntervals } from '../src/features/sharing/private-calendar/calendar-capture.ts';
import { createCalendarQueryRange } from '../src/features/google-sync/calendar-availability.ts';

const oldVersion = 'liflow-shared-2-draft-57';
const category = { id: 'personal', name: '私用', color: '#3D906A', revision: 1 };
const rule = { unit: 'month', interval: 1, on: 'dates', days: [11, 12] };
const value = (extra = {}) => ({ ...newEventDraft('2026-11-11', 'Asia/Tokyo'), title: '毎月11日、12日ハッカソン', allDay: true, recurrence: 'custom', customRecurrence: rule, ...extra });
const command = (extra = {}) => ({ scope: 'series', anchorDate: null, value: value(), category, ...extra });
const payload = (id, extra = {}) => ({ eventId: id, scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value: value(), category: { id: category.id, name: category.name, color: category.color }, ...extra });
function frozenSource(name) {
  const provenance = JSON.parse(readFileSync(new URL('./fixtures/calendar-draft57/provenance.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL(`./fixtures/calendar-draft57/${name}.ts.txt`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.files[`${name}.ts.txt`].sha256);
  return source;
}
function evaluate(source, mocks = {}) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  Function('require', 'module', 'exports', outputText)(name => { assert.ok(name in mocks, `Unexpected frozen import ${name}`); return mocks[name]; }, module, module.exports);
  return module.exports;
}
function oldCapabilities() {
  const source = frozenSource('payload-schema');
  return evaluate(source.slice(source.indexOf('export const V2_SCHEDULER_VERSION'), source.indexOf('type RecordValue')));
}
async function acknowledge(device) {
  const facts = await loadSharedFacts(device.database, groupId); const checkpoint = await readSharingCheckpoint(device.database, groupId);
  await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, checkpoint.cursor, now().getTime(), device.repository.evidenceForServerReceipts(receiptsFor(facts)));
  return facts;
}

test('draft57 rejects the new month date shape and its frozen Google importer requests safe expansion of the standard RRULE', () => {
  const legacy = evaluate(frozenSource('recurrence'), { '../scheduling/local-date.ts': dateModule });
  assert.throws(() => legacy.validateCustomRecurrence(rule), /毎月/); assert.deepEqual(validateCustomRecurrence(rule), rule);
  const oldImport = evaluate(frozenSource('google-event-import'), { '../../domain/calendar/events.ts': eventModule,
    '../../domain/scheduling/local-date.ts': dateModule, './import-formatter.ts': importFormatter });
  const remote = { id: 'old-client-month-dates', ...googleEventBody(value()) };
  assert.match(remote.recurrence[0], /BYMONTHDAY=11,12/);
  assert.throws(() => oldImport.googleImportedEvent(remote, 'personal'), oldImport.GoogleEventExpansionRequired);
  const instance = { ...remote, recurrence: undefined, recurringEventId: remote.id, originalStartTime: remote.start };
  assert.equal(oldImport.googleImportedEvent(instance, 'personal', 'Asia/Tokyo', true).recurrence, 'none');
  assert.equal(remote.recurrence[0], 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=11,12');
});

test('draft58 retains every supported older scheduler while only the new month dates capability requires its owner-approved epoch', () => {
  const old = oldCapabilities(); assert.equal(old.V2_SCHEDULER_VERSION, oldVersion);
  assert.equal(old.isSupportedV2Scheduler(V2_SCHEDULER_VERSION), false);
  assert.equal(supportsCalendarMonthDates(V2_SCHEDULER_VERSION), true);
  for (const version of [oldVersion, 'liflow-shared-2-draft-56', 'liflow-shared-2-draft-55', 'liflow-shared-2-draft-41']) {
    assert.equal(supportsSharedCalendar(version), true); assert.equal(supportsCalendarMonthDates(version), false);
  }
  assert.equal(supportsOneOffChores(oldVersion), true);
});

test('old shared groups save established recurrence but reject new month dates before creating an intent signed fact or Outbox item', async t => {
  const f = await fixture({ schedulerVersion: oldVersion }); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds()); let sequence = 0;
  const c = createV2GroupController(d.repository, { makeId: () => `month-gate-${++sequence}`, now, sync: async () => {} });
  await c.actions.saveCalendarEvent(command({ value: value({ recurrence: 'monthly', customRecurrence: undefined }) }));
  const before = await loadSharedFacts(d.database, groupId); const outbox = await listSharingOutbox(d.database, groupId);
  await assert.rejects(c.actions.saveCalendarEvent(command({ intentId: 'calendar-intent.old-month-dates' })), { code: 'sharing/calendar-month-dates-upgrade-required', message: CALENDAR_MONTH_DATES_UPGRADE_MESSAGE });
  assert.deepEqual(await loadSharedFacts(d.database, groupId), before); assert.deepEqual(await listSharingOutbox(d.database, groupId), outbox);
  assert.equal(d.connection.prepare('SELECT count(*) n FROM sharing_v2_mutation_intents').get().n, 0);
  assert.equal(f.archive.at(-1).body.schedulerVersion, oldVersion);
});

test('the shared receiver rejects a low-level new month rule authored in an old epoch and rolls back every local signed write', async t => {
  const f = await fixture({ schedulerVersion: oldVersion }); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const before = await loadSharedFacts(d.database, groupId); const outbox = await listSharingOutbox(d.database, groupId);
  await assert.rejects(d.repository.commit([{ operationId: 'bypass-month-gate', entityType: 'calendarEvent', entityId: 'bypass-month-gate', operationType: 'patch', payload: payload('bypass-month-gate') }]), { code: 'sharing/v2-authority-denied', message: CALENDAR_MONTH_DATES_UPGRADE_MESSAGE });
  assert.deepEqual(await loadSharedFacts(d.database, groupId), before); assert.deepEqual(await listSharingOutbox(d.database, groupId), outbox);
});

test('owner-approved month date upgrade preserves historical signatures and restores one complete multi-date series into another SQLite database', async t => {
  const f = await fixture({ schedulerVersion: oldVersion }); const d = await f.device(); const second = await f.device('member', f.member);
  t.after(() => d.connection.close()); t.after(() => second.connection.close()); await d.repository.commit(seeds()); const before = await acknowledge(d);
  const previous = f.archive.at(-1); assert.throws(() => rosterModule.upgradeSharedScheduler(previous, f.member), /owner/);
  const next = rosterModule.upgradeSharedScheduler(previous, f.owner); f.archive.push(next);
  assert.equal(next.body.schedulerVersion, V2_SCHEDULER_VERSION); assert.deepEqual(next.body.members, previous.body.members);
  assert.equal(next.body.keyVersion, previous.body.keyVersion + 1); assert.equal(rosterModule.upgradeSharedScheduler(next, f.owner), next);
  let ordinal = 0; const c = createV2GroupController(d.repository, { makeId: () => `approved-month-${++ordinal}`, now, sync: async () => {} });
  await c.actions.saveCalendarEvent(command()); const facts = await acknowledge(d);
  for (const original of before) assert.deepEqual(facts.find(fact => fact.operation.operationId === original.operation.operationId), original);
  await applyReceivedSharedFacts(second.database, groupId, facts, String(facts.length), second.repository.project, null, now().getTime(), second.repository.evidenceForServerReceipts(receiptsFor(facts)));
  const current = await second.repository.readState(); const records = readSharedCalendar(current.assessment.view);
  assert.equal(records.length, 1); assert.deepEqual(records[0].heads[0].payload.value.customRecurrence, rule);
  const event = { ...records[0].heads[0].payload.value, id: records[0].id, revision: 1 };
  assert.deepEqual(projectCalendarEvents([event], [], '2026-11-01', '2026-12-31').map(row => row.startDate), ['2026-11-11', '2026-11-12', '2026-12-11', '2026-12-12']);
});

test('a late delivery cannot legalize a month date rule signed before its feature epoch even after the group upgrades', async t => {
  const f = await fixture({ schedulerVersion: oldVersion }); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds()); const facts = await acknowledge(d);
  const oldEpoch = f.archive.at(-1); const state = await d.repository.readState(); const context = { ...state.replica.frontier };
  const operation = validateSharedOperation({ schemaVersion: 2, operationId: 'late-old-month-rule', groupId, authorUserId: 'owner', authorDeviceId: f.owner.deviceId,
    keyVersion: oldEpoch.body.keyVersion, deviceSequence: (context[f.owner.deviceId] ?? 0) + 1, logicalClock: state.replica.logicalClock + 1, context, receiptContext: context,
    recordedAt: now().toISOString(), entityType: 'calendarEvent', entityId: 'late-old-month-rule', operationType: 'patch', payload: payload('late-old-month-rule') });
  const fact = signSharedOperation(operation, f.owner); f.archive.push(rosterModule.upgradeSharedScheduler(oldEpoch, f.owner));
  const receipt = { schemaVersion: 2, groupId, operationId: operation.operationId, authorUserId: 'owner', authorDeviceId: f.owner.deviceId,
    receivedKeyVersion: f.archive.at(-1).body.keyVersion, uploadSequence: operation.logicalClock, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: now().getTime() };
  const view = createV2HistoryView(buildSharedReplica(groupId, facts.map(item => item.operation)));
  assert.throws(() => validateV2DeliveredAuthority(view, f.archive, fact, receipt), { code: 'sharing/v2-authority-denied', message: CALENDAR_MONTH_DATES_UPGRADE_MESSAGE });
  assert.deepEqual(await loadSharedFacts(d.database, groupId), facts);
});

test('a frozen draft57 workspace checks the new scheduler before opening group payloads and leaves its trusted record intact', async t => {
  const f = await fixture({ schedulerVersion: oldVersion }); const next = rosterModule.upgradeSharedScheduler(f.archive.at(-1), f.owner);
  const old = oldCapabilities(); const module = loadNativeModule('src/features/sharing/workspace-protocol.ts', {
    './operations.ts': operationModule, './cloud-contract.ts': cloudContract, './roster.ts': rosterModule,
    './v2/payload-schema.ts': { isSupportedV2Scheduler: old.isSupportedV2Scheduler },
  });
  const record = { groupId, anchor: f.archive[0], rosterArchive: [...f.archive, next], status: 'active' }; const original = structuredClone(record);
  assert.throws(() => module.verifyWorkspaceArchive(record), { code: 'sharing/scheduler-version-mismatch' }); assert.deepEqual(record, original);
});

test('private busy-calendar schema remains interval-only and rejects new recurrence data without changing the previous cache', () => {
  const range = createCalendarQueryRange('2026-11-01', '2026-12-31', 'Asia/Tokyo');
  const interval = { start: '2026-11-11T01:00:00Z', end: '2026-11-11T02:00:00Z' };
  const cache = { ownerUserId: 'owner', accountGeneration: 'generation', mainDeviceId: 'device', mainRevision: 1, calendarBinding: 'binding', timeZone: 'Asia/Tokyo',
    fetchedAt: '2026-11-01T00:00:00Z', coverage: { start: range.timeMin, end: range.timeMax }, intervals: [interval] };
  const before = sharedDocumentDigest(cache); assert.equal(validatedPrivateBusyIntervals(cache).length, 1);
  assert.throws(() => validatedPrivateBusyIntervals({ ...cache, customRecurrence: rule }));
  assert.throws(() => snapshotPrivateCalendarIntervals([{ ...interval, customRecurrence: rule }], range));
  assert.equal(sharedDocumentDigest(cache), before); assert.deepEqual(snapshotPrivateCalendarIntervals([interval], range), [{ start: '2026-11-11T01:00:00.000Z', end: '2026-11-11T02:00:00.000Z' }]);
});
