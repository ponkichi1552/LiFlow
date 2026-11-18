import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2WasteVisibilityId } from '../src/features/sharing/v2/waste-state.ts';
import { projectV2WasteCalendar } from '../src/features/sharing/v2/calendar-waste-policy.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const weekly = { label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [2] };
const rule = input => ({ recurrence: input.recurrence, collectionWeekdays: input.collectionWeekdays,
  anchorDate: input.anchorDate ?? null, monthlyDay: input.monthlyDay ?? null });
const ids = field => field.candidates.map(candidate => candidate.operationId);
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `waste-${d.options.userId}-${++n}`, now, sync: async () => {} }); }
const read = (c, input = range) => c.readModel(input, { waste: true });
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup() { const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds()); const c = controller(d);
  const created = await c.actions.addWasteSchedule(weekly); const id = created[0].entityId;
  return { f, d, c, id, row: async () => (await read(c)).waste.rows.find(row => row.id === id), close: () => d.connection.close() }; }

test('v2 shared waste uses the existing weekly biweekly and monthly calculations without private adapters', async () => {
  const f = await setup();
  try {
    await f.c.actions.addWasteSchedule({ label: 'びん', recurrence: 'biweekly', collectionWeekdays: [2], anchorDate: '2026-10-27' });
    await f.c.actions.addWasteSchedule({ label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31 });
    const normal = await f.c.readModel(range); const model = await read(f.c); assert.equal(normal.waste, undefined); assert.deepEqual(model.plan, normal.plan);
    assert.equal(model.waste.schedules.length, 3); assert.equal(model.waste.range.through, '2026-12-01');
    assert.deepEqual(model.waste.occurrences.filter(row => row.occurrence.label === 'びん').map(row => row.occurrence.date), ['2026-10-27', '2026-11-10', '2026-11-24']);
    assert.deepEqual(model.waste.occurrences.filter(row => row.occurrence.label === '粗大ごみ').map(row => row.occurrence.date), ['2026-10-31', '2026-11-30']);
    assert.ok(model.waste.occurrences.every(row => row.occurrence.householdId === `shared:${groupId}`));
    assert.equal((await f.d.repository.readState()).assessment.view.ofType('datePermission').length, 0);
  } finally { f.close(); }
});

test('v2 waste edits merge an unrelated name but keep a changed collection rule atomic and reject stale sources', async () => {
  const f = await setup();
  try {
    const base = await f.row();
    await f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: rule({ recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 28 }), basisOperationIds: ids(base.fields.rule) }]);
    await f.c.actions.editWasteSchedule(f.id, [{ field: 'label', value: '資源ごみ', basisOperationIds: ids(base.fields.label) }]);
    const current = await f.row(); assert.equal(current.schedule.label, '資源ごみ'); assert.equal(current.schedule.recurrence, 'monthly'); assert.equal(current.schedule.monthlyDay, 28);
    const before = await listSharingOutbox(f.d.database, groupId);
    await assert.rejects(f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: rule({ ...weekly, collectionWeekdays: [4] }), basisOperationIds: ids(base.fields.rule) }]), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(f.c.actions.editWasteSchedule(f.id, [{ field: 'label', value: '別の名前', basisOperationIds: ids(current.fields.rule) }]), { code: 'sharing/v2-stale-settings' });
    assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
    const facts = (await loadSharedFacts(f.d.database, groupId)).filter(fact => fact.operation.entityId === f.id);
    assert.deepEqual(Object.keys(facts[1].operation.payload).sort(), ['anchorDate', 'collectionWeekdays', 'monthlyDay', 'recurrence']);
  } finally { f.close(); }
});

test('v2 concurrent shared collection rules remain whole candidates and an explicit resolution converges independently of other chores', async () => {
  const f = await setup(); const member = await f.f.device('member', f.f.member);
  try {
    await receive(member, await loadSharedFacts(f.d.database, groupId)); const b = controller(member); const base = await f.row();
    await f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: rule({ recurrence: 'biweekly', collectionWeekdays: [2], anchorDate: '2026-10-27' }), basisOperationIds: ids(base.fields.rule) }]);
    await b.actions.editWasteSchedule(f.id, [{ field: 'rule', value: rule({ recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 15 }), basisOperationIds: ids(base.fields.rule) }]);
    await receive(f.d, await loadSharedFacts(member.database, groupId)); let current = await f.row();
    assert.equal(current.fields.rule.kind, 'conflict'); assert.equal(current.schedule, null); assert.equal((await read(f.c)).waste.occurrences.length, 0);
    assert.ok((await read(f.c)).plan.occurrences.length > 0);
    const sources = ids(current.fields.rule); const selected = current.fields.rule.candidates[0].value;
    await assert.rejects(f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: selected, basisOperationIds: sources }]), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: selected, basisOperationIds: sources, resolveOperationIds: sources.slice(0, 1) }]), { code: 'sharing/v2-stale-settings' });
    await f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: selected, basisOperationIds: sources, resolveOperationIds: sources }]);
    await receive(member, await loadSharedFacts(f.d.database, groupId)); await receive(f.d, await loadSharedFacts(member.database, groupId));
    current = await f.row(); assert.equal(current.needsReview, false); assert.equal(current.schedule.recurrence, selected.recurrence);
    assert.deepEqual((await read(f.c)).waste, (await read(b)).waste);
  } finally { member.connection.close(); f.close(); }
});

test('v2 legacy partial collection edits are reconstructed at their original causal cuts rather than producing a mixed rule', async () => {
  const f = await setup(); const member = await f.f.device('member', f.f.member);
  try {
    await receive(member, await loadSharedFacts(f.d.database, groupId));
    await f.d.repository.commit([draft('partial-weekday', 'waste', f.id, { collectionWeekdays: [3] })]);
    await member.repository.commit([draft('partial-fortnight', 'waste', f.id, { recurrence: 'biweekly', anchorDate: '2026-10-27' })]);
    await receive(f.d, await loadSharedFacts(member.database, groupId)); const current = await f.row();
    assert.equal(current.fields.rule.kind, 'conflict'); assert.equal(current.schedule, null);
    const selected = current.fields.rule.candidates.find(candidate => candidate.value?.recurrence === 'weekly');
    assert.deepEqual(selected.value.collectionWeekdays, [3]); assert.equal(selected.value.anchorDate, null);
    await f.c.actions.editWasteSchedule(f.id, [{ field: 'rule', value: selected.value, basisOperationIds: ids(current.fields.rule), resolveOperationIds: ids(current.fields.rule) }]);
    const result = await f.row(); assert.equal(result.schedule.recurrence, 'weekly'); assert.deepEqual(result.schedule.collectionWeekdays, [3]); assert.equal(result.schedule.anchorDate, undefined);
  } finally { member.connection.close(); f.close(); }
});

test('v2 waste hide and restore bind their displayed schedule and visibility without replaying identical requests', async () => {
  const f = await setup();
  try {
    let model = await read(f.c); const first = model.waste.occurrences[0]; assert.equal(first.hidden, false);
    await f.c.actions.setWasteOccurrenceHidden(first.selection, true); let current = (await read(f.c)).waste.occurrences[0]; assert.equal(current.hidden, true);
    const before = await listSharingOutbox(f.d.database, groupId); const duplicate = await f.c.actions.setWasteOccurrenceHidden(first.selection, true); assert.equal(duplicate.length, 0);
    await assert.rejects(f.c.actions.setWasteOccurrenceHidden(first.selection, false), { code: 'sharing/v2-stale-settings' });
    assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
    await f.c.actions.setWasteOccurrenceHidden(current.selection, false); current = (await read(f.c)).waste.occurrences[0]; assert.equal(current.hidden, false);
    await assert.rejects(f.c.actions.setWasteOccurrenceHidden({ ...current.selection, date: '2026-10-28' }, true), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(f.c.actions.setWasteOccurrenceHidden({ ...current.selection, groupId: 'another-group' }, true), { code: 'sharing/v2-stale-settings' });
    const row = await f.row(); await f.c.actions.editWasteSchedule(f.id, [{ field: 'label', value: '別のゴミ', basisOperationIds: ids(row.fields.label) }]);
    await assert.rejects(f.c.actions.setWasteOccurrenceHidden(current.selection, true), { code: 'sharing/v2-stale-settings' });
    const latest = await f.row(); await assert.rejects(f.c.actions.deleteWasteSchedule(f.id, row.revision), { code: 'sharing/v2-stale-settings' });
    await f.c.actions.deleteWasteSchedule(f.id, latest.revision); assert.equal((await f.row()).deleted, true);
    await assert.rejects(f.c.actions.editWasteSchedule(f.id, [{ field: 'label', value: '復活', basisOperationIds: ids(latest.fields.label) }]), { code: 'sharing/v2-stale-settings' });
    assert.equal((await read(f.c)).waste.occurrences.length, 0);
  } finally { f.close(); }
});

test('v2 conflicting visibility is unresolved until the current occurrence is explicitly reviewed and tombstones remain reversible', async () => {
  const f = await setup(); const member = await f.f.device('member', f.f.member);
  try {
    const first = (await read(f.c)).waste.occurrences[0]; await f.c.actions.setWasteOccurrenceHidden(first.selection, true);
    await receive(member, await loadSharedFacts(f.d.database, groupId)); const b = controller(member);
    await f.c.actions.setWasteOccurrenceHidden((await read(f.c)).waste.occurrences[0].selection, false);
    await b.actions.setWasteOccurrenceHidden((await read(b)).waste.occurrences[0].selection, false);
    await b.actions.setWasteOccurrenceHidden((await read(b)).waste.occurrences[0].selection, true);
    await receive(f.d, await loadSharedFacts(member.database, groupId)); const current = (await read(f.c)).waste.occurrences[0]; assert.equal(current.hidden, null);
    const calendar = await f.c.readModel(range, { waste: true, wasteCalendarPolicy: true });
    assert.equal(calendar.waste.calendarPolicy.complete, true, 'a visibility conflict is known evidence, not missing exception coverage');
    assert.equal(calendar.waste.calendarPolicy.exceptions.find(entry => entry.key === current.key)?.hidden, null);
    assert.equal(projectV2WasteCalendar(calendar.waste.calendarPolicy, calendar.waste.rows, calendar.waste.schedules,
      current.occurrence.date, current.occurrence.date)[0]?.hidden, null);
    await assert.rejects(f.c.actions.setWasteOccurrenceHidden(current.selection, true), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(f.c.actions.setWasteOccurrenceHidden(first.selection, true, true), { code: 'sharing/v2-stale-settings' });
    await f.c.actions.setWasteOccurrenceHidden(current.selection, true, true); assert.equal((await read(f.c)).waste.occurrences[0].hidden, true);
    await f.d.repository.commit([{ ...draft('delete-visibility', 'wasteVisibility', v2WasteVisibilityId(f.id, first.occurrence.date), {}), operationType: 'delete' }]);
    const cleared = (await read(f.c)).waste.occurrences[0]; assert.equal(cleared.hidden, false);
    await f.c.actions.setWasteOccurrenceHidden(cleared.selection, true); assert.equal((await read(f.c)).waste.occurrences[0].hidden, true);
  } finally { member.connection.close(); f.close(); }
});

test('v2 waste projections keep a valid edit after a quarantined operation and never rebuild a replica with its causal hole removed', async () => {
  const f = await setup();
  try {
    await receive(f.d, await loadSharedFacts(f.d.database, groupId));
    const base = { schemaVersion: 2, receiptContext: { [f.f.owner.deviceId]: 5 }, recordedAt: now().toISOString(), groupId, authorUserId: 'member', authorDeviceId: f.f.member.deviceId, keyVersion: 2,
      context: { [f.f.owner.deviceId]: 5 }, deviceSequence: 1, logicalClock: 6, operationType: 'patch' };
    const invalid = signSharedOperation({ ...base, operationId: 'rejected-cadence', entityType: 'chorePolicy', entityId: 'floor', payload: { configuration: { ...seeds()[3].payload.configuration, ruleVersion: 2 } } }, f.f.member);
    const good = signSharedOperation({ ...base, operationId: 'accepted-waste', deviceSequence: 2, logicalClock: 7, context: { ...base.context, [f.f.member.deviceId]: 1 },
      entityType: 'waste', entityId: 'independent-waste', payload: { label: 'びん', ...rule({ recurrence: 'weekly', collectionWeekdays: [4] }) } }, f.f.member);
    await receive(f.d, [invalid, good]); const state = await f.d.repository.readState(); assert.ok(state.assessment.rejected.some(entry => entry.operationId === 'rejected-cadence'));
    assert.ok((await read(f.c)).waste.schedules.some(schedule => schedule.id === 'independent-waste'));
  } finally { f.close(); }
});

test('v2 waste previews stay within a historical month and stop safely at the supported end date', async () => {
  const f = await setup();
  try {
    const historical = await read(f.c, { from: '2020-01-01', through: '2020-01-31', asOfDate: '2026-10-27' });
    assert.equal(historical.waste.range.through, '2020-01-31'); assert.ok(historical.waste.occurrences.every(row => row.occurrence.date.startsWith('2020-01')));
    const last = await read(f.c, { from: '9999-12-31', through: '9999-12-31', asOfDate: '9999-12-31' }); assert.equal(last.waste.range.through, '9999-12-31');
  } finally { f.close(); }
});

test('v2 a concurrent waste deletion requires a current explicit choice and restoring it binds the reviewed complete rule', async () => {
  for (const keep of [false, true]) {
    const f = await setup(); const member = await f.f.device('member', f.f.member);
    try {
      await receive(member, await loadSharedFacts(f.d.database, groupId)); const b = controller(member); const base = await f.row();
      await f.c.actions.deleteWasteSchedule(f.id, base.revision);
      await b.actions.editWasteSchedule(f.id, [{ field: 'label', value: '可燃ゴミ', basisOperationIds: ids(base.fields.label) }]);
      await receive(f.d, await loadSharedFacts(member.database, groupId)); const current = await f.row();
      assert.equal(current.fields.presence.kind, 'conflict'); assert.equal(current.schedule, null);
      const before = await listSharingOutbox(f.d.database, groupId);
      await assert.rejects(f.c.actions.resolveWastePresence(f.id, base.revision, keep, weekly), { code: 'sharing/v2-stale-settings' });
      if (keep) await assert.rejects(f.c.actions.resolveWastePresence(f.id, current.revision, true), /名前とルール/u);
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      await f.c.actions.resolveWastePresence(f.id, current.revision, keep, { ...weekly, label: '確認した収集日' });
      const resolved = await f.row(); assert.equal(resolved.deleted, !keep);
      if (keep) { assert.equal(resolved.schedule.label, '確認した収集日'); assert.equal(resolved.schedule.recurrence, 'weekly'); }
      else assert.equal((await read(f.c)).waste.occurrences.length, 0);
      await receive(member, await loadSharedFacts(f.d.database, groupId)); await receive(f.d, await loadSharedFacts(member.database, groupId));
      assert.deepEqual((await read(f.c)).waste, (await read(b)).waste);
    } finally { member.connection.close(); f.close(); }
  }
});
