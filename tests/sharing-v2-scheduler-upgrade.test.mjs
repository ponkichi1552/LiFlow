import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { applianceResult, uploadedApplianceResult } from './helpers/sharing-v2-appliance.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { upgradeSharedScheduler, verifySharedRosterTransition, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { signSharedDocument } from '../src/features/sharing/crypto.ts';
import { sharedWorkspaceProtocol } from '../src/features/sharing/workspace-protocol.ts';
import { V2_SCHEDULER_VERSION } from '../src/features/sharing/v2/payload-schema.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };

test('draft38 groups retain settings chores completions and legacy analysis until an owner-signed forward upgrade, then accept uploaded manuals', async () => {
  const base = await fixture({ schedulerVersion: 'liflow-shared-2-draft-38' }); const device = await base.device(); let id = 0;
  const c = createV2GroupController(device.repository, { makeId: () => `upgrade-${++id}`, now, sync: async () => {} });
  try {
    await device.repository.commit(seeds());
    const legacy = await c.actions.reviewAppliance({ reviewed: true, result: applianceResult(), addTaskNames: [] });
    const before = await c.readModel(range, { appliances: true, applianceId: legacy.applianceId });
    const point = before.plan.occurrences[0];
    await c.actions.complete({ choreId: point.choreId, anchorDate: point.anchorDate, ruleVersion: point.ruleVersion, subjectUserId: null }, { performedAt: now().toISOString() });
    const completed = await c.readModel(range, { appliances: true, applianceId: legacy.applianceId });
    assert.ok(completed.plan.history.length); assert.equal(completed.plan.algorithm, 'liflow-shared-2-draft-38');
    const { result: uploaded, manual } = uploadedApplianceResult(); uploaded.product.modelNumber = 'UPLOADED'; uploaded.analysis.model = 'UPLOADED';
    await assert.rejects(c.actions.reviewAppliance({ reviewed: true, result: uploaded, addTaskNames: [] }), /互換更新/);
    const countBeforeForgery = (await device.repository.readState()).assessment.view.ready.length;
    await assert.rejects(device.repository.commit([{ operationId: 'forged-pre-upgrade-upload', entityType: 'appliance', entityId: 'forged-manual', operationType: 'patch',
      payload: { manufacturer: uploaded.product.manufacturer, productName: uploaded.product.productName, modelNumber: uploaded.product.modelNumber,
        displayName: 'forged', officialManualUrl: uploaded.officialSources.manualUrl, analysis: uploaded.analysis, reviewed: true,
        createdAt: now().toISOString(), updatedAt: now().toISOString() } }]), /Uploaded manuals require/u);
    assert.equal((await device.repository.readState()).assessment.view.ready.length, countBeforeForgery, 'receiver authority must reject bypassing the UI upgrade check');
    const previous = base.archive.at(-1); assert.equal(sharedWorkspaceProtocol(previous), 2);
    assert.throws(() => upgradeSharedScheduler(previous, base.member), /owner/);
    const next = upgradeSharedScheduler(previous, base.owner); base.archive.push(next);
    assert.equal(next.body.schedulerVersion, V2_SCHEDULER_VERSION); assert.equal(next.body.previousDigest, sharedRosterDigest(previous));
    assert.deepEqual(next.body.members, previous.body.members); assert.equal(next.body.keyVersion, previous.body.keyVersion + 1);
    const after = await c.readModel(range, { appliances: true, applianceId: legacy.applianceId });
    assert.deepEqual(after.plan.occurrences, completed.plan.occurrences); assert.deepEqual(after.plan.history, completed.plan.history);
    assert.deepEqual(after.appliances, completed.appliances); assert.deepEqual(after.configurations, completed.configurations);
    assert.ok((await c.actions.reviewAppliance({ reviewed: true, result: uploaded, manual, addTaskNames: [] })).applianceId);
    const body = { ...next.body, revision: next.body.revision + 1, keyVersion: next.body.keyVersion + 1,
      previousDigest: sharedRosterDigest(next), schedulerVersion: previous.body.schedulerVersion };
    const rollback = { body, signer: next.signer, signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, base.owner) };
    assert.throws(() => verifySharedRosterTransition(next, rollback), /move forward/);
    assert.equal(upgradeSharedScheduler(next, base.owner), next, 'a repeated upgrade is a no-op');
  } finally { device.connection.close(); }
});
