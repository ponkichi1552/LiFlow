import { compareOperationIds } from '../operations.ts';
import { createGroupPolicy } from './model.ts';
import type { GroupKind } from './model.ts';
import { readVerifiedLegacyMigrationSource } from './legacy-migration-source.ts';
import type { VerifiedLegacyMigration } from './legacy-migration-source.ts';

/** Owner review only. Do not infer a group kind, prior assignees, recording time or v2 occurrence aliases. */
export function previewLegacyMigration(checkpoint: VerifiedLegacyMigration, choice: { userId: string; kind: GroupKind }) {
  const source = readVerifiedLegacyMigrationSource(checkpoint);
  if (choice.userId !== source.roster.body.ownerUserId || !['family', 'roommates'].includes(choice.kind)) throw new Error('管理者がグループの種類を選択してください。');
  const { replica } = source;
  const active = new Set(replica.completions.flatMap(item => item.activeOperationIds));
  const undo = new Map<string, string[]>();
  for (const op of replica.operations) if (op.entityType === 'completion' && op.operationType === 'undo') {
    const target = op.payload.targetOperationId as string; const ids = undo.get(target) ?? []; ids.push(op.operationId); undo.set(target, ids);
  }
  return {
    mode: 'previewOnly' as const, mayActivate: false as const, groupId: replica.groupId,
    sourceSnapshotDigest: source.sourceSnapshotDigest, sourceSnapshotId: source.snapshotId, throughSequence: source.throughSequence,
    selectedPolicy: createGroupPolicy(choice.kind),
    entities: replica.entities,
    legacyCompletions: replica.operations.filter(op => op.entityType === 'completion' && op.operationType === 'complete').map(op => ({
      operationId: op.operationId, legacyOccurrenceId: op.entityId, choreId: op.payload.choreId,
      performedAt: op.payload.completedAt, performedByUserId: op.payload.completedByMemberId ?? null,
      recordedByUserId: op.authorUserId, recordedAt: null, originalAssigneeIds: null,
      active: active.has(op.operationId), originalOutcome: op.payload.outcome,
      undoOperationIds: (undo.get(op.operationId) ?? []).sort(compareOperationIds),
    })).sort((a, b) => compareOperationIds(a.operationId, b.operationId)),
    unresolvedFields: replica.entities.filter(entity => Object.keys(entity.conflicts).length).map(entity => ({
      entityType: entity.entityType, entityId: entity.entityId, fields: Object.keys(entity.conflicts).sort(compareOperationIds),
    })),
    requiredReview: ['perChoreV2PolicyAndAnchor', 'legacyOccurrenceAliases', 'privateGoogleMappingAliases', 'approvedDeviceCompatibility', 'newDatabaseGenerationAndKey'] as const,
    // Existing roster approval does not prove an installed app understands schema2.
    devices: source.roster.body.members.flatMap(member => member.devices.map(device => ({
      userId: member.userId, deviceId: device.identity.deviceId, protocolSupport: 'unconfirmed' as const,
    }))),
  };
}
