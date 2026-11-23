import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { JsonValue, SharedOperation } from '../operations.ts';
import { readSharedCalendar, sharedCalendarPayload } from './calendar-state.ts';
import { v2CompletionHistory } from './completion-history.ts';
import { observedDateRules } from './formal-rule-view.ts';
import type { GroupPolicy, SharedChoreConfiguration } from './model.ts';
import { v2DatePermissionId, v2OccurrenceId } from './occurrence-id.ts';
import { sharedRecipeId } from './standard-catalog.ts';
import { v2ReadPoint } from './view-point.ts';
import type { WorkspaceCopyDestination, WorkspaceCopyPosition } from './workspace-copy-origin.ts';
import { verifyWorkspaceCopy, type SignedWorkspaceCopy } from './workspace-copy-source.ts';

export function copiedChoreId(sourceId: string, destinationId: string, choreId: string) {
  const recipe = sharedRecipeId(sourceId, choreId);
  return recipe ? `${destinationId}.${recipe}` : choreId;
}

/** The copied settings are new edits. Completion/undo and their approvals remain original evidence. */
export function planWorkspaceCopy(copy: SignedWorkspaceCopy, source: WorkspaceCopyPosition, destination: WorkspaceCopyDestination, adminUserId: string, name: string) {
  const { archive, assessment, receipts } = verifyWorkspaceCopy(copy, source, destination);
  const roster = archive.at(-1)!;
  const view = assessment.view;
  const at = v2ReadPoint(view, roster);
  const selected = new Set(destination.userIds);
  if (!selected.has(adminUserId)) throw new Error('新しいグループの管理者を確認してください。');
  const choreId = (id: string) => copiedChoreId(source.groupId, destination.groupId, id);
  const stableId = (...parts: JsonValue[]) => `copied.${sharedDocumentDigest([destination.groupId, ...parts])}`;

  const initial: SharedOperationDraft[] = [];
  const whenApproved: SharedOperationDraft[] = [];
  const fieldConflict = '元グループの競合を解決してから引き継いでください。';
  const observe = (type: SharedOperation['entityType'], id: string, keys: string[]) => {
    const payload: Record<string, JsonValue> = {};
    for (const key of keys) {
      const field = view.field(type, id, key, at);
      if (field) payload[key] = field.value;
    }
    return payload;
  };
  const settings = observe('settings', 'settings', [...new Set(view.topic('settings', 'settings').flatMap(fact => Object.keys(fact.payload)))]);
  const policy = view.field('groupPolicy', 'policy', 'configuration', at)?.value as unknown as GroupPolicy | undefined;
  if (!policy || typeof settings.timeZone !== 'string' || typeof settings.anchorDate !== 'string') throw new Error('元グループの設定が揃っていません。');
  initial.push({ operationId: `${destination.groupId}.bootstrap.policy`, entityType: 'groupPolicy', entityId: 'policy', operationType: 'patch', payload: { configuration: JSON.parse(JSON.stringify(policy)) } },
    { operationId: `${destination.groupId}.bootstrap.settings`, entityType: 'settings', entityId: 'settings', operationType: 'patch', payload: { ...settings, name } });

  for (const type of ['appliance', 'chore', 'baseline', 'dependency', 'waste', 'wasteVisibility'] as const) {
    const ids = new Set(view.ofType(type).map(fact => fact.entityId));
    for (const id of [...ids].sort()) {
      if (view.field(type, id, '$alive', at)?.value !== true) continue;
      const payload = observe(type, id, [...new Set(view.topic(type, id).flatMap(fact => Object.keys(fact.payload)))]);
      if (type === 'dependency') for (const field of ['predecessorChoreId', 'successorChoreId']) {
        if (typeof payload[field] === 'string') payload[field] = choreId(payload[field]);
      }
      initial.push({ operationId: stableId(type, id), entityType: type, entityId: type === 'chore' || type === 'baseline' ? choreId(id) : id,
        operationType: 'patch', payload });
    }
  }

  for (const id of [...new Set(view.ofType('chorePolicy').map(fact => fact.entityId))].sort()) {
    if (view.field('chore', id, '$alive', at)?.value !== true) continue;
    const configurations = view.topic('chorePolicy', id).map(fact => fact.payload.configuration as unknown as SharedChoreConfiguration)
      .sort((a, b) => a.ruleVersion - b.ruleVersion);
    configurations.forEach((configuration, index) => {
      if (configuration.ruleVersion !== index + 1) throw new Error(fieldConflict);
      const memberIds = [...configuration.policy.assignment.memberIds, ...(configuration.policy.assignment.rotation?.sequence ?? []), ...(configuration.targetMemberIds ?? [])];
      if (memberIds.some(uid => !selected.has(uid))) throw new Error('担当設定に含まれるメンバーも引き継いでください。');
      whenApproved.push({ operationId: stableId('chorePolicy', id, configuration.ruleVersion), entityType: 'chorePolicy', entityId: choreId(id),
        operationType: 'patch', payload: { configuration: JSON.parse(JSON.stringify(configuration)) } });
    });
  }

  for (const id of [...new Set(view.ofType('datePermission').map(fact => fact.entityId))].sort()) {
    const payload = observe('datePermission', id, ['choreId', 'userId', 'enabled', 'rights']);
    if (payload.enabled !== true) continue;
    if (typeof payload.userId !== 'string' || !selected.has(payload.userId) || typeof payload.choreId !== 'string') throw new Error('日時変更権限のあるメンバーも引き継いでください。');
    payload.choreId = choreId(payload.choreId);
    whenApproved.push({ operationId: stableId('datePermission', id), entityType: 'datePermission',
      entityId: v2DatePermissionId(destination.groupId, String(payload.choreId), String(payload.userId)), operationType: 'patch', payload });
  }

  for (const record of readSharedCalendar(view, at)) {
    if (record.heads.length !== 1 || record.exceptions.some(exception => exception.heads.length !== 1)) throw new Error(fieldConflict);
    const current = sharedCalendarPayload(record.heads[0]);
    if (!current.value) continue;
    const eventId = stableId('event', record.id);
    initial.push({ operationId: eventId, entityType: 'calendarEvent', entityId: eventId, operationType: 'patch',
      payload: { ...record.heads[0].payload, eventId, basisOperationIds: [], resetExceptionIds: [] } });
    for (const exception of record.exceptions) {
      const operationId = stableId('exception', record.id, exception.anchorDate);
      initial.push({ operationId, entityType: 'calendarEvent', entityId: operationId, operationType: 'patch',
        payload: { ...exception.heads[0].payload, eventId, basisOperationIds: [] } });
    }
  }

  for (const fact of observedDateRules(view, at, assessment.approvedRules).sort((a, b) => a.deviceSequence - b.deviceSequence)) {
    const rule = fact.rule;
    if (fact.excludedSelectors?.length || rule.basisRuleIds?.length || (rule.subjectUserId && !selected.has(rule.subjectUserId))
      || rule.timeZoneAtCreation !== settings.timeZone) throw new Error('引き継ぐ日時指定を元グループで確認してください。');
    const id = stableId('designation', rule.id);
    const { basisRuleIds: _basis, reviewedRequestIds: _review, ...configuration } = rule;
    configuration.id = id;
    configuration.choreId = choreId(rule.choreId);
    configuration.issuerUserId = adminUserId;
    if (rule.selector.scope === 'once') configuration.selector = { ...rule.selector, occurrenceId: v2OccurrenceId(destination.groupId, configuration.choreId, rule.selector.anchorDate) };
    whenApproved.push({ operationId: id, entityType: 'designation', entityId: id, operationType: 'patch', payload: { configuration: JSON.parse(JSON.stringify(configuration)) } });
  }

  // These states need a deliberate policy for rebasing or copying document chunks.
  // Fail before creating a destination if a source requires them.
  const unsupported = ['assignmentRule', 'assignmentRequest', 'claim', 'claimResolution', 'manualDocument', 'manualChunk', 'historyRetention'] as const;
  if (unsupported.some(type => view.ofType(type).length)
    || assessment.requestStates.some(request => !['approved', 'rejected', 'tooLate', 'expired', 'blocked'].includes(request.kind))) {
    throw new Error('未解決の共有変更または追加の確認が必要なデータがあります。');
  }
  const sourceHistory = v2CompletionHistory(view, at, receipts);
  const history = sourceHistory.filter(record => record.active).map(record => ({ ...record,
    copiedChoreId: choreId(record.choreId), choreName: String(view.field('chore', record.choreId, 'name', at)?.value ?? '以前の家事') }));
  return { initial, whenApproved, policy, settings, history, originalAdmin: roster.body.ownerUserId };
}

export type CopiedCompletionRecord = ReturnType<typeof planWorkspaceCopy>['history'][number];
