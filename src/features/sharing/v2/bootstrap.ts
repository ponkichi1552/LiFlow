import { createHouseholdChoreDefinitions } from '../../../domain/chores/catalog.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import { sharedPatchFromDefinition } from '../planning.ts';
import { createGroupPolicy } from './model.ts';
import type { GroupKind } from './model.ts';

/** Fresh v2 data only. This function has no access to a personal or an existing group's database. */
export function v2GroupBootstrap(input: { groupId: string; ownerUserId: string; ownerDisplayName: string; name: string; timeZone: string; anchorDate: LocalDate; kind: GroupKind }): SharedOperationDraft[] {
  const operations: SharedOperationDraft[] = [
    { operationId: `${input.groupId}.bootstrap.policy`, entityType: 'groupPolicy', entityId: 'policy', operationType: 'patch', payload: { configuration: JSON.parse(JSON.stringify(createGroupPolicy(input.kind))) } },
    { operationId: `${input.groupId}.bootstrap.settings`, entityType: 'settings', entityId: 'settings', operationType: 'patch', payload: { name: input.name, timeZone: input.timeZone, anchorDate: input.anchorDate,
      frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 } },
    { operationId: `${input.groupId}.bootstrap.member`, entityType: 'member', entityId: input.ownerUserId, operationType: 'patch', payload: { userId: input.ownerUserId, displayName: input.ownerDisplayName } },
  ];
  for (const builtIn of createHouseholdChoreDefinitions('unused-v2-bootstrap')) {
    const id = `${input.groupId}.${builtIn.id}`;
    operations.push({ operationId: `${input.groupId}.bootstrap.chore.${operations.length}`, entityType: 'chore', entityId: id,
      operationType: 'patch', payload: { ...sharedPatchFromDefinition({ ...builtIn, id, enabled: false }), requiresCycleSelection: builtIn.requiresCycleSelection === true } });
  }
  return operations;
}
