import { createDatabase } from './sqlite.mjs';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { initializeV2EventStore, createV2EventRepository } from '../../src/platform/storage/sharing-v2-events.ts';
import { createDeviceIdentity, signSharedDocument } from '../../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice } from '../../src/features/sharing/roster.ts';
import { v2AuthorProofDigest } from '../../src/features/sharing/v2/server-receipts.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../../src/features/sharing/v2/model.ts';

export const groupId = 'v2-repository'; export const scope = { groupId, userId: 'owner', householdId: 'group-local' };
export const now = () => new Date('2026-10-27T01:00:00Z');
export const receiptsFor = (facts) => facts.map((fact) => ({ schemaVersion: 2, groupId,
  operationId: fact.operation.operationId, authorUserId: fact.operation.authorUserId, authorDeviceId: fact.operation.authorDeviceId,
  receivedKeyVersion: fact.operation.keyVersion, uploadSequence: fact.operation.logicalClock,
  authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: now().getTime() }));
export const draft = (operationId, entityType, entityId, payload) => ({ operationId, entityType, entityId, payload, operationType: 'patch' });
export const seeds = () => [
  draft('policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('family') }),
  draft('settings', 'settings', 'settings', { name: '検査グループ', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }),
  draft('floor', 'chore', 'floor', { name: '床を掃除する', enabled: true }),
  draft('configuration', 'chorePolicy', 'floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27',
    intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
];
export async function fixture({ clock = now, schedulerVersion } = {}) {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const initial = createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 });
  if (schedulerVersion) { initial.body.schedulerVersion = schedulerVersion; initial.signature = signSharedDocument({ domain: 'liflow-shared-roster-v1', body: initial.body }, owner); }
  const archive = [initial]; archive.push(approveSharedDevice(archive[0], owner, 'member', member));
  async function device(userId = 'owner', identity = owner, databasePath) {
    const h = createDatabase(databasePath); await initializeV2EventStore(h.database, { ...scope, userId });
    let writable = true;
    const options = { ...scope, userId, identity, anchor: archive[0], archive: () => archive, now: clock, assertWritable: () => { if (!writable) throw new Error('account changed'); } };
    const repository = createV2EventRepository(h.database, options);
    return { ...h, repository, options, stopWrites: () => { writable = false; },
      state: () => { const row = h.connection.prepare('SELECT * FROM sharing_v2_projection').get(); return row ? {
        accepted: JSON.parse(row.accepted_ids_json), rejected: JSON.parse(row.rejected_json), pending: JSON.parse(row.pending_ids_json), hash: row.fact_hash } : null; } };
  }
  return { owner, member, archive, device };
}
