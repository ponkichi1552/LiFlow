import { V2_SCHEDULER_VERSION } from './payload-schema.ts';
import { readSharedCalendar } from './calendar-state.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { createV2PlannerActions } from './actions.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { v2ReadPoint } from './view-point.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { normalizeV2Configuration } from './configuration-normalization.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { v2DecisionReviews } from './decision-review.ts';
import type { SharedChoreConfiguration } from './model.ts';
import { readV2EditableField, V2_CHORE_DETAIL_FIELDS } from './field-edit.ts';
import type { V2ChoreDetailField, V2EditableField } from './field-edit';
import { readV2DateRights } from './date-rights-edit.ts';
import { v2MembershipStart } from './membership-period.ts';
import { buildV2WastePlan } from './waste-state.ts';
import { buildV2ApplianceModel } from './appliance-state.ts';
import type { LegacyCompletionRecord } from './legacy-history.ts';
type V2ModelRange = { from: LocalDate; through: LocalDate; asOfDate: LocalDate };

/** Injected transport keeps the screen independent of production, Emulator, and offline test workspaces. */
export function createV2GroupController(repository: ReturnType<typeof createV2EventRepository>, options: {
  makeId: () => string; now: () => Date; sync: () => Promise<unknown>;
}) {
  const actions = createV2PlannerActions(repository, options);
  return {
    actions, sync: options.sync,
    async readModel(inputRange: V2ModelRange | ((context: { timeZone: string }) => V2ModelRange), readOptions: { detailChoreId?: string; choreSettings?: boolean; groupPolicy?: boolean; permissionsChoreId?: string; waste?: boolean; appliances?: boolean; applianceId?: string } = {}) {
      const state = await repository.readState();
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
      let range: V2ModelRange;
      if (typeof inputRange === 'function') {
        let zone;
        try { zone = state.assessment.view.field('settings', 'settings', 'timeZone', at)?.value; }
        catch (error) { if (!readOptions.groupPolicy) throw error; }
        // A repair-only settings read must not depend on the very timezone conflict it lets the administrator resolve.
        // The resulting common plan remains uninitialized and date actions stay disabled.
        if (typeof zone !== 'string') {
          if (!readOptions.groupPolicy) throw new Error('グループの地域を確認してください。');
          zone = 'UTC';
        }
        range = inputRange({ timeZone: zone });
      } else range = inputRange;
      const plan = buildV2CommonPlan(state, range);
      const configurations = plan.chores.map((chore) => {
        const facts = state.assessment.view.topic('chorePolicy', chore.id); const candidates = maximalCausalFacts(facts);
        let configuration: SharedChoreConfiguration | null = null;
        try { configuration = state.assessment.view.field('chorePolicy', chore.id, 'configuration', at)?.value as unknown as SharedChoreConfiguration ?? null; } catch { /* Expose explicit candidates to the administrator. */ }
        return { choreId: chore.id, configuration, revision: facts.reduce((maximum, op) => Math.max(maximum, (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion), 0),
          earliestEffectiveFrom: facts.map((op) => { const cfg = op.payload.configuration as unknown as SharedChoreConfiguration; return cfg.effectiveFrom ?? cfg.anchorDate; }).sort().at(-1) ?? range.asOfDate,
          candidates: candidates.map((op) => ({ operationId: op.operationId, authorUserId: op.authorUserId, recordedAt: op.recordedAt!, configuration: normalizeV2Configuration(op.payload.configuration as unknown as SharedChoreConfiguration) })) };
      });
      const reviews = v2DecisionReviews(state, repository.scope.userId);
      const choreDetails = plan.chores.filter((chore) => readOptions.choreSettings || chore.id === readOptions.detailChoreId).map((chore) => ({ choreId: chore.id, alive: readV2EditableField(state.assessment.view, at, 'chore', chore.id, '$alive'),
        fields: Object.fromEntries(V2_CHORE_DETAIL_FIELDS.map((field) => [field, readV2EditableField(state.assessment.view, at, 'chore', chore.id, field)])) as Record<V2ChoreDetailField, V2EditableField> }));
      const groupPolicy = readOptions.groupPolicy || readOptions.permissionsChoreId || readOptions.choreSettings ? readV2EditableField(state.assessment.view, at, 'groupPolicy', 'policy', 'configuration') : undefined;
      const groupSettings = readOptions.groupPolicy ? Object.fromEntries(['name', 'timeZone'].map(field =>
        [field, readV2EditableField(state.assessment.view, at, 'settings', 'settings', field)])) : undefined;
      const permissionChores = plan.chores.filter(chore => readOptions.choreSettings || chore.id === readOptions.permissionsChoreId);
      const permissionMembers = permissionChores.length ? plan.members.filter(member => member.active && member.userId !== state.archive.at(-1)!.body.ownerUserId)
        .map(member => {
          const start = v2MembershipStart(state.archive, member.userId, at.keyVersion);
          if (start === null) throw new Error('メンバーの参加状態を確認してください。'); return { userId: member.userId, start };
        }) : [];
      const choreDateRights = permissionChores.map(chore => ({ choreId: chore.id, alive: readV2EditableField(state.assessment.view, at, 'chore', chore.id, '$alive'),
        membershipStarts: Object.fromEntries(permissionMembers.map(member => [member.userId, member.start])),
        fields: Object.fromEntries(permissionMembers.map(member => [member.userId, readV2DateRights(state.assessment.view, at, chore.id, member.userId, member.start)])) }));
      const dateRights = choreDateRights.find(chore => chore.choreId === readOptions.permissionsChoreId);
      const waste = readOptions.waste ? buildV2WastePlan(state.assessment.view, at, range) : undefined;
      const appliances = readOptions.appliances ? buildV2ApplianceModel(state.assessment.view, at, readOptions.applianceId) : undefined;
      const recoveryHistory = state.replica.recoveryWitnesses ?? [];
      return { calendar: readSharedCalendar(state.assessment.view, at), calendarSupported: state.archive.at(-1)!.body.schedulerVersion === V2_SCHEDULER_VERSION, plan, configurations, choreDetails, ...(readOptions.choreSettings ? { choreDateRights } : {}), ...(groupPolicy ? { groupPolicy } : {}), ...(groupSettings ? { groupSettings } : {}), ...(dateRights ? { dateRights } : {}), ...(waste ? { waste } : {}), ...(appliances ? { appliances } : {}), viewerUserId: repository.scope.userId, adminUserId: state.archive.at(-1)!.body.ownerUserId,
        ...(recoveryHistory.length ? { recoverySummary: { heldChanges: recoveryHistory.reduce((sum, witness) => sum
          + witness.body.entries.filter(entry => entry.classification === 'blockedCausality').length, 0), recoveries: recoveryHistory.length } } : {}),
        requests: state.assessment.requestStates, requestReviews: reviews.date, assignmentReviews: reviews.assignment,
        dateRules: observedDateRules(state.assessment.view, at, state.assessment.approvedRules),
        dateRuleSources: observedDateRules(state.assessment.view, at, state.assessment.approvedRules, true),
        assignmentRequests: state.assessment.assignmentRequests, assignmentRules: state.assessment.view.assignmentsAt(at)?.facts ?? [], pendingChanges: state.assessment.pendingOutboxIds.length,
        receiptPending: state.assessment.provisionalOperationIds.length, quarantinedChanges: state.assessment.rejected.length + state.replica.pendingOperationIds.length };
    },
  };
}
export type V2GroupController = ReturnType<typeof createV2GroupController>;
export type V2GroupScreenModel = Awaited<ReturnType<V2GroupController['readModel']>> & {
  legacyHistory?: LegacyCompletionRecord[];
};
