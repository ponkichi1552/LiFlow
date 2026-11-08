import { canonicalJson } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { rosterAtOperation } from './authority-context.ts';
import { normalizeV2Configuration } from './configuration-normalization.ts';
import { v2AssignmentLineage } from './assignment-lineage.ts';
import { commonFrame } from './common-frames.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { v2ConfigurationTimeline } from './configuration-timeline.ts';
import { v2AnchorAtIndex, v2AnchorIndexBefore } from './cadence.ts';

/** Keep the last issued schedule phase when changing only its period. */
function latestScheduledAnchor(view: V2HistoryView, at: SharedOperation, choreId: string, through: LocalDate): LocalDate | undefined {
  let latest: LocalDate | undefined;
  for (const slice of v2ConfigurationTimeline(view, choreId, at)) {
    const cfg = slice.configuration;
    if (!cfg || cfg.active === false || slice.from > through) continue;
    const last = slice.through && slice.through < through ? slice.through : through;
    if (last < cfg.anchorDate) continue;
    const date = v2AnchorAtIndex(cfg, v2AnchorIndexBefore(cfg, last));
    if (date >= slice.from && (!latest || date > latest)) latest = date;
  }
  return latest;
}

export class V2StaleSettingsError extends Error {
  readonly code = 'sharing/v2-stale-settings';
  constructor() { super('別の変更が届いています。最新の設定を確認してから、もう一度変更してください。'); }
}
export class V2AssignmentRemapError extends Error {
  readonly code = 'sharing/v2-assignment-remap-required';
  constructor() { super('変更後の周期では担当の適用回が変わります。担当を今回から変えるか、次回から変えるか確認してください。'); }
}
export type V2ConfigurationPatch = Partial<Pick<SharedChoreConfiguration, 'policy' | 'anchorDate' | 'intervalDays' | 'monthly' | 'windowBeforeDays' | 'windowAfterDays' | 'active'>>;
export type V2ConfigurationFieldEdit = { [Key in keyof V2ConfigurationPatch]: { field: Key; baseRuleVersion: number; value: V2ConfigurationPatch[Key] } }[keyof V2ConfigurationPatch];

export function prepareV2ConfigurationEdit(input: { view: V2HistoryView; archive: readonly VerifiedSharedRoster[]; at: SharedOperation; choreId: string;
  value: Omit<SharedChoreConfiguration, 'ruleVersion'>; expectedRuleVersion?: number; preserveAssignments?: boolean; resolveConfigurationIds?: string[]; rebaseCadence?: boolean }): SharedChoreConfiguration {
  const facts = input.view.observed(input.view.topic('chorePolicy', input.choreId), input.at);
  const maximum = facts.reduce((value, op) => Math.max(value, (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion), 0);
  if (maximum !== (input.expectedRuleVersion ?? 0)) throw new V2StaleSettingsError();
  if (!input.value.effectiveFrom) throw new Error('この設定を適用する日を選んでください。');
  let previous: ReturnType<V2HistoryView['field']> = null;
  if (maximum) try { previous = input.view.field('chorePolicy', input.choreId, 'configuration', input.at); }
  catch {
    const conflicts = maximalCausalFacts(facts).map((op) => op.operationId).sort();
    if (!input.resolveConfigurationIds || canonicalJson([...input.resolveConfigurationIds].sort()) !== canonicalJson(conflicts)) throw new V2StaleSettingsError();
    if (input.preserveAssignments !== false) throw new V2AssignmentRemapError();
    if (input.value.policy.completion === 'perMember' && input.value.policy.assignment.mode === 'all' && !input.value.targetMemberIds) throw new V2StaleSettingsError();
  }
  const old = previous?.value as unknown as SharedChoreConfiguration | undefined;
  const latestBoundary = facts.map((op) => { const cfg = op.payload.configuration as unknown as SharedChoreConfiguration; return cfg.effectiveFrom ?? cfg.anchorDate; }).sort().at(-1);
  if (latestBoundary && input.value.effectiveFrom < latestBoundary) throw new V2StaleSettingsError();
  const { assignmentSourceVersion: _source, ...value } = input.value;
  const configuration = normalizeV2Configuration({ ...value, ruleVersion: maximum + 1 });
  if (input.rebaseCadence && old && !configuration.monthly && (old.monthly || configuration.intervalDays !== old.intervalDays) && configuration.anchorDate === old.anchorDate) {
    configuration.anchorDate = latestScheduledAnchor(input.view, input.at, input.choreId, input.value.effectiveFrom) ?? old.anchorDate;
  }
  if (configuration.policy.assignment.rotation) {
    configuration.rotationSourceVersion = old?.policy.assignment.rotation
      && canonicalJson(old.policy.assignment.rotation) === canonicalJson(configuration.policy.assignment.rotation)
      ? old.rotationSourceVersion ?? old.ruleVersion : configuration.ruleVersion;
  } else delete configuration.rotationSourceVersion;
  if (configuration.policy.completion !== 'perMember' || configuration.policy.assignment.mode !== 'all') delete configuration.targetMemberIds;
  if (configuration.policy.completion === 'perMember' && configuration.policy.assignment.mode === 'all' && !configuration.targetMemberIds) {
    const oldSets = old?.policy.completion === 'perMember' && old.policy.assignment.mode === 'all'
      ? previous!.operations.map((op) => (old.targetMemberIds ?? rosterAtOperation(input.archive, op).body.members.map((member) => member.userId)).slice().sort())
      : [input.archive.at(-1)!.body.members.map((member) => member.userId).sort()];
    if (new Set(oldSets.map((ids) => canonicalJson(ids))).size > 1) throw new V2StaleSettingsError();
    configuration.targetMemberIds = oldSets[0];
  }
  if (old) {
    const lineage = v2AssignmentLineage(input.view, input.at, input.choreId, old);
    const assignments = (input.view.assignmentsAt(input.at)?.facts ?? input.view.observed(input.view.ofType('assignmentRule'), input.at))
      .filter((op) => op.payload.choreId === input.choreId && lineage.has(op.payload.ruleVersion as number));
    const pendingRequests = (input.view.assignmentsAt(input.at)?.requests ?? []).filter((request) => !request.cancelled && ['pendingDelivery', 'awaiting', 'conflict'].includes(request.kind)
      && request.proposal.choreId === input.choreId && lineage.has(request.proposal.ruleVersion));
    const samePolicy = canonicalJson(old.policy) === canonicalJson(configuration.policy);
    if ((assignments.length || pendingRequests.length) && input.preserveAssignments !== false) {
      if (!samePolicy) throw new V2AssignmentRemapError();
      if (old.targetMemberIds && configuration.targetMemberIds && canonicalJson(old.targetMemberIds) !== canonicalJson(configuration.targetMemberIds)) throw new V2AssignmentRemapError();
      for (const anchor of [...assignments.map((op) => op.payload.fromAnchorDate as LocalDate), ...pendingRequests.map((request) => request.proposal.anchorDate)]) {
        if (anchor < input.value.effectiveFrom) continue;
        try { commonFrame(input.view.groupId, input.choreId, configuration, anchor); } catch { throw new V2AssignmentRemapError(); }
      }
      configuration.assignmentSourceVersion = old.ruleVersion;
    }
  }
  return configuration;
}

/** Merge edits to different fields, but never silently overwrite a field changed since the displayed base revision. */
export function mergeV2ConfigurationPatch(input: { view: V2HistoryView; at: SharedOperation; choreId: string; baseRuleVersion: number; patch: V2ConfigurationPatch; effectiveFrom: LocalDate }) {
  const read = (version?: number) => input.view.field('chorePolicy', input.choreId, 'configuration', input.at,
    (op) => version === undefined || (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion === version)?.value as unknown as SharedChoreConfiguration | undefined;
  const current = read(); const base = read(input.baseRuleVersion); if (!current || !base) throw new V2StaleSettingsError();
  const same = (left: unknown, right: unknown) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
  const allowed = new Set(['policy', 'anchorDate', 'intervalDays', 'monthly', 'windowBeforeDays', 'windowAfterDays', 'active']);
  let changed = false;
  for (const [field, value] of Object.entries(input.patch)) {
    if (!allowed.has(field)) throw new Error('変更する設定を確認してください。');
    const key = field as keyof SharedChoreConfiguration;
    const currentValue = key === 'monthly' ? current.monthly === true : current[key];
    const baseValue = key === 'monthly' ? base.monthly === true : base[key];
    if (!same(currentValue, baseValue) && !same(currentValue, value)) throw new V2StaleSettingsError();
    if (!same(currentValue, value)) changed = true;
  }
  if (!changed) return null;
  return { expectedRuleVersion: current.ruleVersion, value: { ...current, ...input.patch, effectiveFrom: input.effectiveFrom } };
}

/** A pending edit keeps the revision actually displayed for its own field, including edits queued during another save. */
export function mergeV2ConfigurationFieldEdits(input: { view: V2HistoryView; at: SharedOperation; choreId: string; edits: readonly NonNullable<V2ConfigurationFieldEdit>[]; effectiveFrom: LocalDate }) {
  const seen = new Set<string>(); let result: ReturnType<typeof mergeV2ConfigurationPatch> = null;
  for (const edit of input.edits) {
    if (seen.has(edit.field)) throw new Error('設定項目が重複しています。'); seen.add(edit.field);
    const next = mergeV2ConfigurationPatch({ ...input, baseRuleVersion: edit.baseRuleVersion, patch: { [edit.field]: edit.value } });
    if (!next) continue;
    if (!result) result = next;
    else Object.assign(result.value, { [edit.field]: edit.value });
  }
  return result;
}
