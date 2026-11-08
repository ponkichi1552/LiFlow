import type { LocalDate } from '../../../domain/shared/types.ts';
import type { VersionVector } from '../operations.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import type { ConfirmationProof } from './confirmation.ts';

export type GroupKind = 'family' | 'roommates';
export interface GroupPolicy {
  kind: GroupKind;
  delegationEnabled: boolean;
  allowBeforeWindow: boolean;
  allowAfterWindow: boolean;
  adminCanFixWithoutConsent: boolean;
  autoApproveEarlier: boolean;
  allowSubstitution: boolean;
  showCompletionStatus: boolean;
  completionPushEnabled: boolean;
}
export type ChorePreset = 'common' | 'eachMember' | 'assigned' | 'rotation' | 'personal';
export interface SharedChoreRotation { sequence: string[]; advanceOn: 'completion' | 'occurrence' }
export interface SharedChorePolicy {
  completion: 'one' | 'perMember';
  assignment: { mode: 'open' | 'all' | 'selected'; memberIds: string[]; rotation?: SharedChoreRotation };
}
export interface SharedChoreConfiguration {
  policy: SharedChorePolicy;
  anchorDate: LocalDate;
  intervalDays: number;
  /** Calendar-month recurrence, preserving the anchor's day and clamping short months to their last day. */
  monthly?: boolean;
  windowBeforeDays: number;
  windowAfterDays: number;
  ruleVersion: number;
  effectiveFrom?: LocalDate;
  active?: boolean;
  /** The subject set does not grow merely because an unrelated cadence edit was authored after someone joined. */
  targetMemberIds?: string[];
  /** An unrelated cadence edit retains original assignment facts and their causal conflicts. */
  assignmentSourceVersion?: number;
  /** Cadence-only edits retain this epoch so a rotation does not restart. */
  rotationSourceVersion?: number;
}
export type DateTarget = { precision: 'date'; date: LocalDate }
  | { precision: 'instant'; at: string }
  | { precision: 'interval'; start: string; end: string };
export type DesignationMode = 'deadline' | 'day' | 'fixed';
export interface CivilRange { from: LocalDate; through: LocalDate | null }
export interface InstantRange { start: number; end: number }
export interface CausalStamp {
  operationId: string; authorDeviceId: string; deviceSequence: number; context: VersionVector;
  receiptContext?: VersionVector;
}
export type RuleSelector = { scope: 'once'; occurrenceId: string; anchorDate: LocalDate }
  | { scope: 'period'; range: CivilRange }
  | { scope: 'ongoing'; from: LocalDate };
export interface DesignationOptions { strict: boolean; adminLocked: boolean; forbidEarlier: boolean; allowDuringCooldown?: boolean }
export type RecordedInstruction = { kind: 'automatic'; timeZone: string }
  | { kind: 'designated'; ruleId: string; mode: DesignationMode; target: DateTarget; strict: boolean; timeZone: string }
  | { kind: 'unconfirmed'; reason: 'dateConflict' | 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' | 'ambiguousTime'; timeZone: string };
export interface ManualRule extends DesignationOptions {
  id: string;
  choreId: string;
  subjectUserId: string | null;
  selector: RuleSelector;
  referenceAnchorDate: LocalDate;
  timeZoneAtCreation: string;
  mode: DesignationMode;
  target: DateTarget;
  issuerUserId: string;
  ruleVersion: number;
  basisRuleIds?: string[];
  reviewedRequestIds?: string[];
}
export interface DateChangeRequest {
  requesterUserId: string; choreId: string; anchorDate: LocalDate; occurrenceId: string; subjectUserId: string | null;
  originalDesignationId: string | null; original: DateTarget | null; proposed: DateTarget;
  proposedMode: DesignationMode; proposedOptions: DesignationOptions; selector: RuleSelector; extensionScope: 'once' | 'future';
  basisRuleIds?: string[];
  reviewedRequestIds?: string[];
  /** Approval removes only these observed sources; null means their complete source periods. */
  cancellation?: DateRuleCancellation;
}
export interface DateRuleCancellation { targetOperationIds: string[]; selector: RuleSelector | null }
export interface AssignmentChangeRequest {
  requesterUserId: string; choreId: string; anchorDate: LocalDate; occurrenceId: string; ruleVersion: number;
  originalMemberIds: string[]; originalAssignmentIds: string[]; originalClaimOperationIds: string[];
  memberIds: string[]; scope: 'once' | 'from'; fixed: boolean; reference: DateTarget; timeZone: string;
}
export interface ManualRuleFact extends CausalStamp {
  rule: ManualRule; confirmation?: ConfirmationProof; sourceRequestId?: string;
  /** Local projection of observed, authorized cancellations; never part of a signed designation. */
  excludedSelectors?: RuleSelector[];
}
export interface SharedOccurrence {
  id: string; choreId: string; anchorDate: LocalDate;
  windowStart: LocalDate; windowEnd: LocalDate; ruleVersion: number;
}
export interface CompletionFact {
  operationId: string; occurrenceId: string; subjectUserId: string | null;
  originalAssigneeIds: string[] | null; performerUserId: string; recorderUserId: string;
  performedAt: string; recordedAt: string;
  acceptance: 'accepted' | 'pending';
}

/** Defaults are used only when creating a policy, never when switching its kind. */
export function createGroupPolicy(kind: GroupKind): GroupPolicy {
  if (!['family', 'roommates'].includes(kind)) throw new Error('グループの種類を確認してください。');
  return { kind, delegationEnabled: kind === 'family', allowBeforeWindow: true,
    allowAfterWindow: kind === 'roommates', adminCanFixWithoutConsent: kind === 'family',
    autoApproveEarlier: true, allowSubstitution: true, showCompletionStatus: true, completionPushEnabled: false };
}
export function changeGroupKind(policy: GroupPolicy, kind: GroupKind): GroupPolicy {
  createGroupPolicy(kind);
  return { ...policy, kind };
}
export function chorePolicyFromPreset(preset: Exclude<ChorePreset, 'personal'>, selected: readonly string[] = [], advanceOn: SharedChoreRotation['advanceOn'] = 'completion'): SharedChorePolicy {
  if (preset === 'eachMember') return { completion: 'perMember', assignment: { mode: 'all', memberIds: [] } };
  if (preset === 'common') return { completion: 'one', assignment: { mode: 'open', memberIds: [] } };
  if (preset === 'rotation') {
    if (selected.length < 2 || selected.length > 64 || new Set(selected).size < 2 || new Set(selected).size > 16) throw new Error('交代するメンバーを2人以上選んでください。');
    selected.forEach(assertSharedIdentifier);
    return { completion: 'one', assignment: { mode: 'selected', memberIds: [...new Set(selected)].sort(), rotation: { sequence: [...selected], advanceOn } } };
  }
  if (preset !== 'assigned' || selected.length === 0 || new Set(selected).size !== selected.length) throw new Error('担当者を選んでください。');
  selected.forEach(assertSharedIdentifier);
  return { completion: 'one', assignment: { mode: 'selected', memberIds: [...selected].sort() } };
}
