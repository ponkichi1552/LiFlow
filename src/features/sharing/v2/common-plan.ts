import { addDays, daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { ChoreDefinition } from '../../../domain/chores/types.ts';
import { canonicalJson, compareOperationIds } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { sharedRosterDigest } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { sharedLocalDate } from '../group-clock.ts';
import type { assessV2BusinessHistory } from './receiver-authority.ts';
import type { DateTarget, DesignationMode, GroupPolicy, ManualRuleFact, SharedOccurrence, SharedChoreConfiguration } from './model.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import { isSupportedV2Scheduler } from './payload-schema.ts';
import { v2ReadPoint } from './view-point.ts';
import { commonFrame, commonFrames } from './common-frames.ts';
import { frameAtOperation } from './authority-context.ts';
import { v2SubjectOccurrenceId } from './occurrence-id.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { manualRuleMatches, selectManualRule, uncancelledRuleRanges } from './period-rules.ts';
import { materializeRuleTarget, v2RuleCalendarAnchorRange } from './rule-target.ts';
import { v2ConfigurationTimeline } from './configuration-timeline.ts';
import { v2CompletionHistory } from './completion-history.ts';
import type { V2CompletionRecord } from './completion-history.ts';
import { expandedCommonWindow } from './window-extension.ts';
import { unresolvedRequestReviews } from './request-review.ts';
import { targetCivilDate, fixedInterval, targetReferenceTime, targetReferenceCivilDate } from './date-target.ts';
import { showExpiredOnHome } from './completion-state.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { v2Dependency, cyclicV2Dependencies, dependencyLowerBound } from './dependency-constraints.ts';
import type { V2Dependency } from './dependency-constraints.ts';
import { indexRetainedRounds } from './retained-round-index.ts';
import { v2RetainedCompletions } from './retained-completions.ts';
import type { V2RetainedAssignmentCut } from './history-retention-schema';

export type V2Assessment = Pick<ReturnType<typeof assessV2BusinessHistory>, 'view' | 'requestStates' | 'approvedRules' | 'receiptEpochs'>;
export interface V2PlanIssue { kind: string; choreId: string | null; occurrenceId: string | null; subjectUserId: string | null; operationIds: string[] }
export type V2FormalDate = { kind: 'automatic' }
  | { kind: 'manual'; ruleId: string; equivalentRuleIds: string[]; mode: DesignationMode; target: DateTarget; timeZone: string; strict: boolean; allowDuringCooldown: boolean }
  | { kind: 'conflict'; ruleIds: string[] } | { kind: 'review'; reason: string; ruleIds: string[] };
export interface V2SubjectPlan {
  id: string; subjectUserId: string | null; required: boolean; assigneeIds: string[]; formalDate: V2FormalDate;
  suggestedDate: LocalDate; executionWindowStart: LocalDate; executionWindowEnd: LocalDate;
  completed: boolean; completionOperationIds: string[]; pendingCompletionIds: string[];
  retainedCompletion?: { checkpointId: string; recorderUserIds: string[]; completedDate: LocalDate; completedAt?: string };
  strictInstructionUnfulfilled: boolean; minimumNextExecutionDay: LocalDate | null; cooldownSuppressed: boolean;
  virtuallyConsumed: boolean; showExpiredOnHome: boolean; requestReviewIds: string[];
  dependencyNotBefore: LocalDate | null; dependencyNotBeforeInstant: number | null; dependencyBlocked: boolean; dependencyAwaitingCompletion: boolean;
}
export interface V2PlannedOccurrence extends SharedOccurrence {
  configuration: SharedChoreConfiguration; assigneeIds: string[]; subjectUserIds: string[];
  claimState: string; claimOperationIds: string[]; assignmentFixed: boolean; needsAssignment: boolean;
  claimantUserIds: string[];
  completed: boolean; historical: boolean; extensionRequestIds: string[]; subjects: V2SubjectPlan[];
  activeInPeriod: boolean;
  assignmentConflictIds: string[];
  assignmentOperationIds: string[];
  assignmentMappingReviewIds: string[];
  assignmentCut?: V2RetainedAssignmentCut;
}
export interface V2CommonPlan {
  groupId: string; algorithm: string; timeZone: string; initialized: boolean;
  range: { from: LocalDate; through: LocalDate; asOfDate: LocalDate };
  policy: GroupPolicy | null; commonSettings: Record<string, JsonValue>;
  chores: Omit<ChoreDefinition, 'householdId'>[]; members: { userId: string; displayName: string; active: boolean }[];
  occurrences: V2PlannedOccurrence[]; history: V2CompletionRecord[]; issues: V2PlanIssue[];
  dependencies: V2Dependency[];
  sourceHash: string; planHash: string;
  historyRetention?: { cutoff: LocalDate; throughSequence: number; digest: string };
}
function digestPages(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000) result.push(sharedDocumentDigest(values.slice(offset, offset + 1000)));
  return result;
}
function fingerprints(values: readonly unknown[]): string[] { return digestPages(values.map((value) => sharedDocumentDigest(value))); }

/** No personal database, Calendar, weather, device preferences, or implicit Date.now can enter this function. */
export function buildV2CommonPlan(input: { assessment: V2Assessment; archive: readonly VerifiedSharedRoster[]; receipts: ReadonlyMap<string, V2ServerReceipt> },
  range: { from: LocalDate; through: LocalDate; asOfDate: LocalDate }): V2CommonPlan {
  [range.from, range.through, range.asOfDate].forEach(parseLocalDate);
  if (range.through < range.from || daysBetween(range.from, range.through) > 3650) throw new Error('Invalid common plan range');
  const assessment = input.assessment; const view = assessment.view; const roster = input.archive.at(-1);
  if (!roster || !isSupportedV2Scheduler(roster.body.schedulerVersion)) throw new Error('Unsupported common planner version');
  const at = v2ReadPoint(view, roster); const issues: V2PlanIssue[] = [];
  // This view/archive is immutable for this one synchronous projection. Never
  // share cached permissions across later receiver accepts or roster revisions.
  const frameContexts = new WeakMap<SharedOperation, Map<string, ReturnType<typeof frameAtOperation>>>();
  const frameContext = (point: SharedOperation, choreId: string, anchorDate: LocalDate, version?: number, allowAssignmentConflict = false) => {
    let byFrame = frameContexts.get(point); if (!byFrame) { byFrame = new Map(); frameContexts.set(point, byFrame); }
    const key = canonicalJson([choreId, anchorDate, version ?? null, allowAssignmentConflict]);
    let result = byFrame.get(key);
    if (!result && !allowAssignmentConflict) {
      const reviewed = byFrame.get(canonicalJson([choreId, anchorDate, version ?? null, true]));
      if (reviewed && !reviewed.assignmentConflictIds.length) result = reviewed;
    }
    if (!result) { result = frameAtOperation(view, input.archive, point, choreId, anchorDate, version, { allowAssignmentConflict }); byFrame.set(key, result); }
    return result;
  };
  const retention = view.retentionAt(at); const retained = v2RetainedCompletions(view, at);
  const retainedIndex = indexRetainedRounds(retained);
  const retainedDigest = retention ? sharedDocumentDigest(retention) : '';
  const assignmentProjection = view.assignmentsAt(at);
  const confirmedAssignmentAnswers = new Set((assignmentProjection?.requests ?? [])
    .flatMap((request) => request.decisions.filter((decision) => decision.kind === 'eligible').map((decision) => decision.operationId)));
  const assignmentChanges = [...view.ofType('assignmentRule'), ...view.ofType('assignmentDecision').filter((op) => op.payload.decision === 'approve' && confirmedAssignmentAnswers.has(op.operationId))];
  const assignmentPayload = (op: SharedOperation) => op.entityType === 'assignmentRule' ? op.payload : (() => {
    const request = view.byId(op.payload.requestId as string)!; return { choreId: request.payload.choreId, ruleVersion: request.payload.ruleVersion,
      scope: request.payload.scope, fromOccurrenceId: request.payload.occurrenceId, fromAnchorDate: request.payload.anchorDate };
  })();
  const issue = (kind: string, choreId: string | null = null, occurrenceId: string | null = null, subjectUserId: string | null = null, operationIds: string[] = []) => {
    issues.push({ kind, choreId, occurrenceId, subjectUserId, operationIds: [...new Set(operationIds)].sort(compareOperationIds) });
  };
  function fields(type: 'chore' | 'settings' | 'member' | 'dependency', id: string): Record<string, JsonValue> {
    const result: Record<string, JsonValue> = {};
    const names = new Set(view.topic(type, id).flatMap((op) => Object.keys(op.payload)));
    for (const name of names) {
      try { const value = view.field(type, id, name, at); if (value) result[name] = value.value; }
      catch { issue(`fieldConflict:${name}`, type === 'chore' ? id : null, null, null,
        maximalCausalFacts(view.topic(type, id).filter((op) => Object.hasOwn(op.payload, name))).map((op) => op.operationId)); }
    }
    return result;
  }
  const commonSettings = fields('settings', 'settings');
  const timeZone = typeof commonSettings.timeZone === 'string' ? commonSettings.timeZone : 'UTC';
  let policy: GroupPolicy | null = null;
  try { policy = view.field('groupPolicy', 'policy', 'configuration', at)?.value as unknown as GroupPolicy ?? null; }
  catch { issue('groupPolicyConflict'); }
  const initialized = Boolean(policy && typeof commonSettings.timeZone === 'string');
  if (!initialized) issue('initialSynchronizationRequired');
  const activeMembers = new Set(roster.body.members.map((member) => member.userId));
  const history = v2CompletionHistory(view, at, input.receipts);
  const historyByFrame = new Map<string, V2CompletionRecord[]>(); const recordsByChore = new Map<string, V2CompletionRecord[]>();
  for (const record of history) {
    const list = historyByFrame.get(record.occurrenceId) ?? []; list.push(record); historyByFrame.set(record.occurrenceId, list);
    const chores = recordsByChore.get(record.choreId) ?? []; chores.push(record); recordsByChore.set(record.choreId, chores);
    if (record.approvalConflictIds.length) issue('substitutionApprovalConflict', record.choreId, record.occurrenceId, record.subjectUserId, record.approvalConflictIds);
    if (record.active && input.receipts.has(record.operationId) && !record.performedTimeConfirmed) issue('reportedTimeNeedsReview', record.choreId, record.occurrenceId, record.subjectUserId, [record.operationId]);
  }
  const ids = new Set([...view.ofType('chore').map((op) => op.entityId), ...history.map((record) => record.choreId)]);
  const chores = [...ids].sort(compareOperationIds).map((id) => {
    const data = fields('chore', id); let alive = false;
    try { alive = view.field('chore', id, '$alive', at)?.value === true; } catch { issue('choreDeletionConflict', id); }
    const cfg = view.ofType('chorePolicy').find((op) => op.entityId === id)?.payload.configuration as unknown as SharedChoreConfiguration | undefined;
    const cycle = cfg?.intervalDays ?? 7;
    return { description: '', category: '家事', frequencyDaysByMode: { frequent: cycle, balanced: cycle, relaxed: cycle },
      windowRadiusDays: 2, maxShiftDays: 4, load: 'normal', holidayPriority: false, everyday: false, instructions: [], tools: [], cautions: [],
      ...data, id, name: typeof data.name === 'string' ? data.name : '家事の設定を確認',
      enabled: initialized && alive && data.enabled === true && data.archived !== true && data.requiresCycleSelection !== true && !issues.some((entry) => entry.choreId === id && entry.kind.startsWith('fieldConflict')),
      archived: !alive || data.archived === true } as Omit<ChoreDefinition, 'householdId'>;
  });
  const memberIds = new Set([...activeMembers, ...history.flatMap((record) => [record.performerUserId, record.recorderUserId, ...record.originalAssigneeIds])]);
  const members = [...memberIds].sort(compareOperationIds).map((userId) => {
    const profile = view.ofType('member').find((op) => op.entityId === userId || op.payload.userId === userId);
    const data = profile ? fields('member', profile.entityId) : {};
    return { userId, displayName: typeof data.displayName === 'string' ? data.displayName : activeMembers.has(userId) ? 'メンバー' : '以前のメンバー', active: activeMembers.has(userId) };
  });
  const allRules = observedDateRules(view, at, assessment.approvedRules);
  const rulesByChore = new Map<string, ManualRuleFact[]>();
  for (const fact of allRules) { const rows = rulesByChore.get(fact.rule.choreId) ?? []; rows.push(fact); rulesByChore.set(fact.rule.choreId, rows); }
  const dependencies: V2Dependency[] = [];
  for (const id of [...new Set(view.ofType('dependency').map((op) => op.entityId))].sort(compareOperationIds)) {
    const data = fields('dependency', id);
    try { if (view.field('dependency', id, '$alive', at)?.value !== true) continue; }
    catch { issue('dependencyPolicyNeedsReview'); continue; }
    delete data.$alive; const edge = v2Dependency(id, data);
    if (edge) dependencies.push(edge); else issue('dependencyPolicyNeedsReview', typeof data.successorChoreId === 'string' ? data.successorChoreId : null);
  }
  const timelines = new Map<string, ReturnType<typeof v2ConfigurationTimeline>>();
  const occurrences: V2PlannedOccurrence[] = [];
  const historyAtCut = new Map<string, V2CompletionRecord[]>();
  function usable(record: V2CompletionRecord): boolean {
    return record.active && record.outcome === 'completed' && record.acceptance === 'accepted'
      && (!input.receipts.has(record.operationId) || record.performedTimeConfirmed);
  }
  function recordedScheduleDay(record: V2CompletionRecord): LocalDate {
    if (record.instruction?.kind === 'designated') return targetCivilDate(record.instruction.target, record.instruction.timeZone);
    const source = view.byId(record.operationId)!;
    return typeof source.payload.scheduledDate === 'string' ? source.payload.scheduledDate as LocalDate : record.anchorDate;
  }
  function completedBefore(frameId: string, point: SharedOperation, context: ReturnType<typeof frameAtOperation>): boolean {
    const key = canonicalJson([frameId, point.context, point.receiptContext ?? null]); let cut = historyAtCut.get(key);
    if (!cut) { cut = v2CompletionHistory(view, point, input.receipts, context.frame); historyAtCut.set(key, cut);
      while (historyAtCut.size > 128) historyAtCut.delete(historyAtCut.keys().next().value!); }
    const active = cut.filter((record) => record.occurrenceId === frameId && usable(record));
    const prior = v2RetainedCompletions(view, point).filter(row => row.choreId === context.frame.choreId && row.anchorDate === context.frame.anchorDate && row.ruleVersion === context.frame.ruleVersion && row.reports.length);
    const done = (uid: string | null) => active.some(record => record.subjectUserId === uid) || prior.some(row => row.subjectUserId === uid);
    return context.config.policy.completion === 'one' ? done(null) : context.subjectUserIds.length > 0 && context.subjectUserIds.every(done);
  }
  for (const chore of chores) {
    const choreRules = rulesByChore.get(chore.id) ?? [];
    const lastCompletionBySubject = new Map<string | null, LocalDate>();
    for (const state of [...retention?.anchors ?? [], ...retainedIndex.forChore(chore.id).filter(row => row.reports.length)]) if (state.choreId === chore.id) {
      const day = sharedLocalDate(new Date(state.instant), timeZone); const prior = lastCompletionBySubject.get(state.subjectUserId);
      if (!prior || day > prior) lastCompletionBySubject.set(state.subjectUserId, day);
    }
    for (const record of recordsByChore.get(chore.id) ?? []) {
      if (!usable(record)) continue;
      const day = sharedLocalDate(new Date(record.performedAt), timeZone);
      const previous = lastCompletionBySubject.get(record.subjectUserId);
      if (!previous || day > previous) lastCompletionBySubject.set(record.subjectUserId, day);
    }
    const frames = new Map<string, SharedOccurrence>();
    const timeline = v2ConfigurationTimeline(view, chore.id, at);
    timelines.set(chore.id, timeline);
    if (chore.enabled && !timeline.length) issue('choreConfigurationRequired', chore.id);
    if (!chore.enabled && !(recordsByChore.get(chore.id)?.length) && !timeline.some((slice) => slice.configuration?.active === true)) continue;
    for (const slice of timeline) {
      if (!slice.configuration) {
        if (slice.from <= range.through && (!slice.through || slice.through >= range.from)) issue(slice.review ?? 'configurationNeedsReview', chore.id, null, null, slice.operationIds);
        continue;
      }
      if (slice.configuration.active === false) continue;
      const bounds = [{ from: range.from, through: range.through }];
      for (const fact of choreRules) {
        const rule = fact.rule; if (rule.choreId !== chore.id || rule.selector.scope === 'once' || rule.ruleVersion !== slice.version) continue;
        try {
          const inverse = v2RuleCalendarAnchorRange(rule, range.from, range.through, timeZone);
          const first = rule.selector.scope === 'period' ? rule.selector.range.from : rule.selector.from;
          const last = rule.selector.scope === 'period' ? rule.selector.range.through : null;
          const { from, through } = inverse;
          const bound = { from: from > first ? from : first, through: last && last < through ? last : through };
          if (bound.from <= bound.through) for (const part of uncancelledRuleRanges(fact, bound)) bounds.push({ from: part.from, through: part.through ?? bound.through });
        } catch { issue('repeatingMappingNeedsReview', chore.id, null, rule.subjectUserId, [fact.operationId]); }
      }
      const merged: { from: LocalDate; through: LocalDate }[] = [];
      for (const bound of bounds.map((bound) => ({ from: bound.from > slice.from ? bound.from : slice.from,
        through: slice.through && slice.through < bound.through ? slice.through : bound.through })).filter((bound) => bound.from <= bound.through)
        .sort((a, b) => compareOperationIds(a.from, b.from))) {
        const previous = merged.at(-1);
        if (previous && bound.from <= previous.through) { if (bound.through > previous.through) previous.through = bound.through; }
        else merged.push({ ...bound });
      }
      try {
        for (const bound of merged) for (const frame of commonFrames(view.groupId, chore.id, slice.configuration, bound.from, bound.through)) frames.set(frame.id, frame);
      } catch { issue('planningRangeNeedsReview', chore.id); }
    }
    for (const fact of assignmentProjection?.facts ?? []) {
      if (fact.payload.choreId !== chore.id || fact.payload.scope !== 'once' || fact.payload.fromAnchorDate < range.from || fact.payload.fromAnchorDate > range.through
        || frames.has(fact.payload.fromOccurrenceId)) continue;
      issue('oneOffAssignmentMappingNeedsReview', chore.id, fact.payload.fromOccurrenceId, null, [fact.sourceRequestId ?? fact.operationId]);
    }
    // A moved one-off date stays visible even when its anchor falls outside the displayed date range.
    for (const fact of choreRules.filter((rule) => rule.rule.selector.scope === 'once')) {
      const selector = fact.rule.selector; if (selector.scope !== 'once') continue;
      const targetDate = fact.rule.mode === 'deadline' ? targetReferenceCivilDate(fact.rule.target, fact.rule.timeZoneAtCreation, timeZone) : targetCivilDate(fact.rule.target, timeZone);
      if (targetDate < range.from || targetDate > range.through) continue;
      const source = view.byId(fact.sourceRequestId ?? fact.operationId);
      if (!source) { issue('oneOffMappingNeedsReview', chore.id, selector.occurrenceId, fact.rule.subjectUserId, [fact.operationId]); continue; }
      try { const frame = frameContext(source, chore.id, selector.anchorDate, fact.rule.ruleVersion).frame;
        if (manualRuleMatches(fact, frame)) frames.set(frame.id, frame); }
      catch { issue('oneOffMappingNeedsReview', chore.id, selector.occurrenceId, fact.rule.subjectUserId, [fact.operationId]); }
    }
    const retainedHistoricalFrames = new Set<string>();
    for (const state of retainedIndex.forChore(chore.id)) if (state.reports.length
      && (state.anchorDate >= range.from && state.anchorDate <= range.through || state.suggestedDate >= range.from && state.suggestedDate <= range.through)) {
      const cfg = view.ofType('chorePolicy').find(op => op.entityId === chore.id && (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion === state.ruleVersion)?.payload.configuration as unknown as SharedChoreConfiguration | undefined;
      if (cfg) { const frame = commonFrame(view.groupId, chore.id, cfg, state.anchorDate); frames.set(frame.id, frame); }
    }
    for (const record of [...(recordsByChore.get(chore.id) ?? [])].sort((a, b) => Number(b.active) - Number(a.active)
      || view.byId(a.operationId)!.logicalClock - view.byId(b.operationId)!.logicalClock || compareOperationIds(a.operationId, b.operationId))) {
      if (record.anchorDate < range.from || record.anchorDate > range.through) {
        const scheduledDate = recordedScheduleDay(record);
        if (!record.active || scheduledDate < range.from || scheduledDate > range.through) continue;
      }
      if (retainedHistoricalFrames.has(record.occurrenceId)) continue;
      // An undone report remains in history but cannot replace an actionable current frame.
      // Prefer any still-active report before considering cancelled historical-only rounds.
      if (!record.active && frames.has(record.occurrenceId)) continue;
      const source = view.byId(record.operationId)!;
      try {
        const context = frameContext(source, chore.id, record.anchorDate, source.payload.ruleVersion as number);
        const current = frames.get(record.occurrenceId);
        retainedHistoricalFrames.add(record.occurrenceId);
        if (!current || current.ruleVersion !== context.frame.ruleVersion) {
          frames.set(context.frame.id, context.frame);
          if (current) issue('configurationChangedDuringRound', chore.id, current.id, record.subjectUserId, [record.operationId]);
        }
      }
      catch { issue('historicalConfigurationNeedsReview', chore.id, record.occurrenceId, record.subjectUserId, [record.operationId]); }
    }
    if (frames.size > 20_000) { issue('planningRangeNeedsReview', chore.id); continue; }
    for (const frame of [...frames.values()].sort((a, b) => compareOperationIds(a.anchorDate, b.anchorDate))) {
      let context: ReturnType<typeof frameAtOperation>; let assignmentCut: V2RetainedAssignmentCut | undefined;
      try {
        context = frameContext(at, chore.id, frame.anchorDate, frame.ruleVersion, true);
        // Once a round was complete, a later assignment change does not reopen it for a new person.
        const changes = view.observed(assignmentChanges, at).filter((op) => { const value = assignmentPayload(op); return value.choreId === chore.id && value.ruleVersion === frame.ruleVersion
          && (value.scope === 'once' ? value.fromOccurrenceId === frame.id : (value.fromAnchorDate as string) <= frame.anchorDate); })
          .sort((a, b) => a.logicalClock - b.logicalClock || compareOperationIds(a.operationId, b.operationId));
        for (const change of changes) {
          try {
            const previous = frameContext(change, chore.id, frame.anchorDate, frame.ruleVersion);
            if (completedBefore(frame.id, change, previous)) { context = previous; assignmentCut = { keyVersion: change.keyVersion, context: change.context, receiptContext: change.receiptContext ?? change.context }; break; }
          } catch { /* Resolving a prior ambiguous assignment must not make the now-resolved round disappear. */ }
        }
        // A work report can know a pending decision without having received its formal acceptance.
        // Preserve a round fully completed under that report's actually observed assignment as well.
        if (changes.length) for (const record of historyByFrame.get(frame.id) ?? []) {
          if (!usable(record)) continue; const work = view.byId(record.operationId); if (!work) continue;
          try {
            const previous = frameContext(work, chore.id, frame.anchorDate, frame.ruleVersion);
            const afterWork = { ...work, context: { ...work.context, [work.authorDeviceId]: work.deviceSequence } };
            if (completedBefore(frame.id, afterWork, previous)) { context = previous; assignmentCut = { keyVersion: work.keyVersion, context: work.context, receiptContext: work.receiptContext ?? work.context }; break; }
          } catch { /* Keep current explicit review when an original assignment cannot be reconstructed. */ }
        }
        const certifiedCut = retainedIndex.forRound(chore.id, frame.anchorDate, frame.ruleVersion).find(row => row.assignmentCut)?.assignmentCut;
        if (certifiedCut) { context = frameContext({ ...at, ...certifiedCut }, chore.id, frame.anchorDate, frame.ruleVersion, true); assignmentCut = certifiedCut; }
      } catch { issue('assignmentNeedsReview', chore.id, frame.id); continue; }
      if (context.assignmentConflictIds.length) issue('assignmentNeedsReview', chore.id, frame.id, null, context.assignmentConflictIds);
      const records = historyByFrame.get(frame.id) ?? []; const actual = records.filter(usable);
      const retainedRound = retainedIndex.forRound(chore.id, frame.anchorDate, frame.ruleVersion);
      const window = expandedCommonWindow({ frame, timeZone, view, at, requests: assessment.requestStates, approvedRules: assessment.approvedRules, receiptEpochs: assessment.receiptEpochs });
      if (window.reviews.length) issue('windowExtensionNeedsReview', chore.id, frame.id, null, window.reviews);
      const past = frame.anchorDate < range.asOfDate;
      const originalSubjects = context.subjectUserIds;
      const alreadyComplete = context.config.policy.completion === 'perMember' && originalSubjects.length > 0
        && originalSubjects.every((uid) => actual.some((record) => record.subjectUserId === uid) || retainedRound.some(row => row.subjectUserId === uid && row.reports.length));
      const requiredSubjects: (string | null)[] = context.config.policy.completion === 'one' ? [null]
        : past || alreadyComplete ? originalSubjects : originalSubjects.filter((uid) => activeMembers.has(uid));
      const subjects = [...new Set([...requiredSubjects, ...records.map((record) => record.subjectUserId), ...retainedRound.filter(row => row.reports.length).map(row => row.subjectUserId)])].sort((a, b) => compareOperationIds(a ?? '', b ?? ''));
      const planned: V2SubjectPlan[] = subjects.map((subjectUserId) => {
        const completed = actual.filter((record) => record.subjectUserId === subjectUserId);
        const retainedState = retainedRound.find(row => row.subjectUserId === subjectUserId && row.reports.length);
        const isCompleted = completed.length > 0 || Boolean(retainedState);
        const pending = records.filter((record) => record.subjectUserId === subjectUserId && record.active && record.outcome === 'completed' && !usable(record));
        const selected = selectManualRule(choreRules, { ...frame, ...window }, subjectUserId, timeZone);
        let formalDate: V2FormalDate = { kind: 'automatic' }; let suggestedDate = frame.anchorDate; let candidates: ManualRuleFact[] = [];
        if (selected.kind === 'conflict') {
          candidates = selected.candidates; formalDate = { kind: 'conflict', ruleIds: candidates.map((fact) => fact.operationId) };
          issue('dateConflict', chore.id, frame.id, subjectUserId, formalDate.ruleIds);
        } else if (selected.kind === 'selected') {
          candidates = choreRules.filter((fact) => selected.equivalentOperationIds.includes(fact.operationId)); const target = materializeRuleTarget(selected.fact.rule, frame, timeZone);
          if (target.kind === 'review') { formalDate = { kind: 'review', reason: target.reason, ruleIds: selected.equivalentOperationIds }; issue(target.reason, chore.id, frame.id, subjectUserId, selected.equivalentOperationIds); }
          else { formalDate = { kind: 'manual', ruleId: selected.fact.operationId, equivalentRuleIds: selected.equivalentOperationIds, mode: selected.fact.rule.mode, target: target.target, timeZone: selected.fact.rule.timeZoneAtCreation,
            strict: selected.fact.rule.strict, allowDuringCooldown: selected.fact.rule.allowDuringCooldown === true };
            suggestedDate = selected.fact.rule.mode === 'deadline' ? targetReferenceCivilDate(target.target, selected.fact.rule.timeZoneAtCreation, timeZone) : targetCivilDate(target.target, timeZone); }
        }
        const reviews = unresolvedRequestReviews({ occurrence: frame, subjectUserId, candidates, allRules, requests: assessment.requestStates, view });
        if (reviews.length) issue('requestConflict', chore.id, frame.id, subjectUserId, reviews);
        const last = lastCompletionBySubject.get(subjectUserId);
        const minimumNextExecutionDay = context.config.intervalDays >= 2 && context.config.intervalDays <= 6 && last ? addDays(last, context.config.intervalDays) : null;
        if (formalDate.kind === 'automatic' && minimumNextExecutionDay && minimumNextExecutionDay > suggestedDate && minimumNextExecutionDay <= window.windowEnd) {
          suggestedDate = minimumNextExecutionDay;
        }
        const suppressed = minimumNextExecutionDay !== null && suggestedDate < minimumNextExecutionDay
          && !(formalDate.kind === 'manual' && formalDate.allowDuringCooldown);
        const dates = [...new Set([...completed.map(recordedScheduleDay), ...(retainedState ? [retainedState.suggestedDate] : [])])].sort();
        if (isCompleted && dates.length === 1) suggestedDate = dates[0];
        if (dates.length > 1) issue('recordedScheduleConflict', chore.id, frame.id, subjectUserId, completed.map((record) => record.operationId));
        return { id: v2SubjectOccurrenceId(frame.id, subjectUserId), subjectUserId, required: requiredSubjects.includes(subjectUserId),
          assigneeIds: subjectUserId === null ? [...context.assigneeIds] : [subjectUserId], formalDate, suggestedDate,
          executionWindowStart: retainedState?.windowStart ?? (formalDate.kind === 'manual' && suggestedDate < window.windowStart ? suggestedDate : window.windowStart),
          executionWindowEnd: retainedState?.through ?? (formalDate.kind === 'manual' && suggestedDate > window.windowEnd ? suggestedDate : window.windowEnd),
          completed: isCompleted, completionOperationIds: completed.map((record) => record.operationId), pendingCompletionIds: pending.map((record) => record.operationId),
          ...(retainedState ? { retainedCompletion: { checkpointId: retainedDigest, recorderUserIds: retainedState.reports.map(report => report.recorderUserId), completedDate: sharedLocalDate(new Date(retainedState.instant), timeZone), completedAt: new Date(retainedState.instant).toISOString() } } : {}),
          strictInstructionUnfulfilled: isCompleted && completed.every((record) => record.strictInstructionFulfilled === false) && (!retainedState || retainedState.strictInstructionUnfulfilled), minimumNextExecutionDay,
          cooldownSuppressed: suppressed && !isCompleted, virtuallyConsumed: !isCompleted && (window.windowEnd < range.asOfDate
            || minimumNextExecutionDay !== null && minimumNextExecutionDay > window.windowEnd && !(formalDate.kind === 'manual' && formalDate.allowDuringCooldown)),
          showExpiredOnHome: !isCompleted && showExpiredOnHome(window.windowEnd, range.asOfDate), requestReviewIds: reviews,
          dependencyNotBefore: null, dependencyNotBeforeInstant: null, dependencyBlocked: false, dependencyAwaitingCompletion: false };
      });
      const currentSlice = timeline.find((slice) => slice.version === frame.ruleVersion && slice.from <= frame.anchorDate && (!slice.through || frame.anchorDate <= slice.through));
      const usesClaims = context.config.policy.completion === 'one' && !context.configuredAssignees.some((uid) => context.activeMemberIds.includes(uid));
      occurrences.push({ ...frame, windowStart: window.windowStart, windowEnd: window.windowEnd, configuration: context.config,
        assigneeIds: [...context.assigneeIds], subjectUserIds: requiredSubjects.filter((uid): uid is string => uid !== null), claimState: usesClaims ? context.claims.kind : 'notApplicable',
        claimantUserIds: usesClaims ? [...new Set(context.claims.activeClaimOperationIds.map((id) => view.byId(id)!.authorUserId))].sort() : [],
        claimOperationIds: [...context.claims.activeClaimOperationIds], assignmentFixed: context.assignmentFixed,
        assignmentConflictIds: [...context.assignmentConflictIds],
        assignmentOperationIds: [...context.assignmentOperationIds],
        assignmentMappingReviewIds: [...context.assignmentMappingReviewIds],
        ...(assignmentCut ? { assignmentCut } : {}),
        needsAssignment: context.assignmentConflictIds.length > 0 || context.configuredAssignees.length > 0 && context.assigneeIds.length === 0 || context.config.policy.completion === 'perMember' && requiredSubjects.length === 0,
        completed: planned.some((slot) => slot.required) && planned.filter((slot) => slot.required).every((slot) => slot.completed),
        historical: !currentSlice, activeInPeriod: Boolean((currentSlice?.configuration && currentSlice.configuration.active !== false
          || choreRules.some((fact) => fact.rule.selector.scope === 'once' && manualRuleMatches(fact, frame))) && (past || chore.enabled)),
        extensionRequestIds: window.sources, subjects: planned });
    }
  }
  const cyclic = cyclicV2Dependencies(dependencies);
  const incoming = new Map<string, V2Dependency[]>();
  for (const edge of dependencies) { const list = incoming.get(edge.successorChoreId) ?? []; list.push(edge); incoming.set(edge.successorChoreId, list); }
  const occurrencesById = new Map(occurrences.map((entry) => [entry.id, entry]));
  const predecessorCache = new Map<string, { day: LocalDate; instant: number | null; occurrenceId: string; completed: boolean } | null>();
  function predecessorEnd(choreId: string, anchor: LocalDate): { day: LocalDate; instant: number | null; occurrenceId: string; completed: boolean } | null {
    const key = `${choreId}:${anchor}`; if (predecessorCache.has(key)) return predecessorCache.get(key)!;
    const choices: SharedOccurrence[] = []; let initial: SharedOccurrence | undefined;
    for (const slice of timelines.get(choreId) ?? []) {
      const cfg = slice.configuration; if (!cfg || cfg.active === false) continue;
      const firstIndex = Math.max(0, Math.ceil(daysBetween(cfg.anchorDate, slice.from) / cfg.intervalDays));
      const first = commonFrame(view.groupId, choreId, cfg, addDays(cfg.anchorDate, firstIndex * cfg.intervalDays));
      if (slice.through && first.anchorDate > slice.through) continue;
      if (!initial || first.anchorDate < initial.anchorDate) initial = first;
      const cut = slice.through && slice.through < anchor ? slice.through : anchor;
      const index = Math.floor(daysBetween(cfg.anchorDate, cut) / cfg.intervalDays);
      if (index < firstIndex) continue;
      choices.push(commonFrame(view.groupId, choreId, cfg, addDays(cfg.anchorDate, index * cfg.intervalDays)));
    }
    for (const record of recordsByChore.get(choreId) ?? []) {
      if (record.anchorDate > anchor || !record.active || record.outcome !== 'completed') continue;
      const source = view.byId(record.operationId)!;
      try { choices.push(frameContext(source, choreId, record.anchorDate, source.payload.ruleVersion as number).frame); } catch { /* The related round remains a review. */ }
    }
    for (const fact of rulesByChore.get(choreId) ?? []) {
      const selector = fact.rule.selector; if (fact.rule.choreId !== choreId || selector.scope !== 'once' || selector.anchorDate > anchor) continue;
      const origin = view.byId(fact.sourceRequestId ?? fact.operationId);
      if (origin) try { choices.push(frameContext(origin, choreId, selector.anchorDate, fact.rule.ruleVersion).frame); } catch { /* An incompatible exception remains a review. */ }
    }
    let frame = choices.sort((a, b) => compareOperationIds(b.anchorDate, a.anchorDate) || a.ruleVersion - b.ruleVersion)[0] ?? initial;
    const recorded = frame && [...(historyByFrame.get(frame.id) ?? [])].sort((a, b) => view.byId(a.operationId)!.logicalClock - view.byId(b.operationId)!.logicalClock || compareOperationIds(a.operationId, b.operationId))[0];
    if (recorded) {
      const source = view.byId(recorded.operationId)!;
      try { frame = frameContext(source, choreId, recorded.anchorDate, source.payload.ruleVersion as number).frame; } catch { /* The related round remains a review. */ }
    }
    let result: { day: LocalDate; instant: number | null; occurrenceId: string; completed: boolean } | null = null;
    if (frame) try {
      const context = frameContext(at, choreId, frame.anchorDate, frame.ruleVersion);
      const subjects: (string | null)[] = context.config.policy.completion === 'one' ? [null] : context.subjectUserIds;
      const records = (historyByFrame.get(frame.id) ?? []).filter(usable);
      const completed = subjects.map(uid => {
        const current = retainedIndex.forRound(choreId, frame.anchorDate, frame.ruleVersion).find(row => row.subjectUserId === uid);
        const prior = current ? current.reports.map(report => report.instant) : (retention?.anchors ?? []).filter(row => row.choreId === choreId && row.anchorDate === frame.anchorDate && row.ruleVersion === frame.ruleVersion && row.subjectUserId === uid).map(row => row.instant);
        const instants = [...records.filter(record => record.subjectUserId === uid).map(record => Date.parse(record.performedAt)), ...prior];
        return instants.length ? Math.min(...instants) : null;
      });
      if (subjects.length && completed.every((instant): instant is number => instant !== null)) {
        const instant = Math.max(...completed); result = { day: sharedLocalDate(new Date(instant), timeZone), instant, occurrenceId: frame.id, completed: true };
      } else if (subjects.length) {
        const window = expandedCommonWindow({ frame, timeZone, view, at, requests: assessment.requestStates, approvedRules: assessment.approvedRules, receiptEpochs: assessment.receiptEpochs });
        const endings: { day: LocalDate; instant: number | null }[] = [];
        for (const uid of subjects) {
          const selected = selectManualRule(rulesByChore.get(choreId) ?? [], frame, uid, timeZone);
          if (selected.kind === 'conflict') break;
          if (selected.kind === 'automatic') endings.push({ day: window.windowEnd, instant: null });
          else {
            const target = materializeRuleTarget(selected.fact.rule, frame, timeZone); if (target.kind === 'review') break;
            const exact = fixedInterval(target.target);
            const deadline = selected.fact.rule.mode === 'deadline' ? targetReferenceTime(target.target, selected.fact.rule.timeZoneAtCreation) : null;
            const instant = exact?.end ?? deadline;
            endings.push({ day: instant === null ? targetCivilDate(target.target, timeZone) : sharedLocalDate(new Date(instant), timeZone), instant });
          }
        }
        if (endings.length === subjects.length && (occurrencesById.has(frame.id) || !(incoming.get(choreId) ?? []).some((entry) => entry.required))) {
          result = { ...endings.sort((a, b) => compareOperationIds(b.day, a.day) || (b.instant ?? 0) - (a.instant ?? 0))[0], occurrenceId: frame.id, completed: false };
        }
      }
    } catch { /* Keep this dependent round visible with a review, rather than dropping it. */ }
    predecessorCache.set(key, result); return result;
  }
  const depth = new Map<string, number>();
  const counts = new Map(chores.map((chore) => [chore.id, 0])); const outgoing = new Map<string, V2Dependency[]>();
  for (const edge of dependencies.filter((entry) => entry.required && !cyclic.has(entry.id))) {
    counts.set(edge.successorChoreId, (counts.get(edge.successorChoreId) ?? 0) + 1);
    const list = outgoing.get(edge.predecessorChoreId) ?? []; list.push(edge); outgoing.set(edge.predecessorChoreId, list);
  }
  const ready = [...counts].filter(([, count]) => count === 0).map(([id]) => id).sort(compareOperationIds);
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]; depth.set(id, index);
    for (const edge of outgoing.get(id) ?? []) { const count = counts.get(edge.successorChoreId)! - 1; counts.set(edge.successorChoreId, count); if (!count) ready.push(edge.successorChoreId); }
  }
  for (const occurrence of [...occurrences].sort((a, b) => (depth.get(a.choreId) ?? 0) - (depth.get(b.choreId) ?? 0))) for (const edge of incoming.get(occurrence.choreId) ?? []) {
    let end = cyclic.has(edge.id) ? null : predecessorEnd(edge.predecessorChoreId, occurrence.anchorDate);
    if (end && occurrencesById.get(end.occurrenceId)?.subjects.some((entry) => !entry.completed && (entry.dependencyBlocked || entry.requestReviewIds.length || entry.formalDate.kind === 'conflict' || entry.formalDate.kind === 'review'))) end = null;
    for (const subject of occurrence.subjects) {
      if (edge.required && !subject.completed && !end?.completed) subject.dependencyAwaitingCompletion = true;
      const lower = end ? dependencyLowerBound(end.day, edge) : null;
      if (edge.required && lower && (!subject.dependencyNotBefore || lower > subject.dependencyNotBefore)) subject.dependencyNotBefore = lower;
      if (edge.required && edge.minimumGapDays === 0 && end?.instant !== null && end?.instant !== undefined
        && (subject.dependencyNotBeforeInstant === null || end.instant > subject.dependencyNotBeforeInstant)) subject.dependencyNotBeforeInstant = end.instant;
      const fixed = subject.formalDate.kind === 'manual' && subject.formalDate.mode === 'fixed' ? fixedInterval(subject.formalDate.target) : null;
      const exact = fixed?.start ?? (subject.formalDate.kind === 'manual' && subject.formalDate.mode === 'deadline' ? targetReferenceTime(subject.formalDate.target, subject.formalDate.timeZone) : null);
      const violation = !lower || subject.suggestedDate < lower || edge.minimumGapDays === 0 && end?.instant !== null && exact !== null && exact < end!.instant!;
      if (!violation) continue;
      if (edge.required && !subject.completed && subject.formalDate.kind === 'automatic' && lower && lower <= subject.executionWindowEnd) {
        subject.suggestedDate = lower; continue;
      }
      if (edge.required && !subject.completed) subject.dependencyBlocked = true;
      issue(cyclic.has(edge.id) ? 'dependencyCycle' : edge.required ? 'requiredDependencyNeedsReview' : 'optionalDependencyWarning', occurrence.choreId, occurrence.id, subject.subjectUserId, [edge.id]);
    }
  }
  // One witness per affected slot suffices; avoid enumerating every pair in a long horizon.
  type FixedSlot = { occurrence: V2PlannedOccurrence; subject: V2SubjectPlan; start: number; end: number; ruleId: string };
  const fixedByAssignee = new Map<string, FixedSlot[]>();
  for (const occurrence of occurrences) for (const subject of occurrence.subjects) {
    if (subject.completed || subject.formalDate.kind !== 'manual' || subject.formalDate.mode !== 'fixed') continue;
    const interval = fixedInterval(subject.formalDate.target); if (!interval) continue;
    for (const uid of subject.assigneeIds) {
      const list = fixedByAssignee.get(uid) ?? [];
      list.push({ occurrence, subject, ...interval, ruleId: subject.formalDate.ruleId }); fixedByAssignee.set(uid, list);
    }
  }
  const overlapping = new Map<string, { slot: FixedSlot; witness: FixedSlot }>();
  for (const list of fixedByAssignee.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end || compareOperationIds(a.subject.id, b.subject.id));
    let furthest: FixedSlot | undefined;
    for (const slot of list) {
      if (furthest && slot.start < furthest.end) {
        if (!overlapping.has(slot.subject.id)) overlapping.set(slot.subject.id, { slot, witness: furthest });
        if (!overlapping.has(furthest.subject.id)) overlapping.set(furthest.subject.id, { slot: furthest, witness: slot });
      }
      if (!furthest || slot.end > furthest.end) furthest = slot;
    }
  }
  for (const { slot, witness } of overlapping.values()) issue('fixedOverlap', slot.occurrence.choreId, slot.occurrence.id,
    slot.subject.subjectUserId, [slot.ruleId, witness.ruleId]);
  occurrences.sort((a, b) => compareOperationIds(a.anchorDate, b.anchorDate) || compareOperationIds(a.choreId, b.choreId));
  issues.sort((a, b) => compareOperationIds(canonicalJson(a), canonicalJson(b)));
  const sourceHash = sharedDocumentDigest({ algorithm: roster.body.schedulerVersion, roster: sharedRosterDigest(roster),
    ...(retention ? { retention: retainedDigest } : {}),
    operations: fingerprints(view.ready), receipts: fingerprints([...input.receipts.values()].sort((a, b) => a.uploadSequence - b.uploadSequence)) });
  const planHash = sharedDocumentDigest({ sourceHash, range, policy, commonSettings,
    chores: fingerprints(chores), members: fingerprints(members), dependencies: fingerprints(dependencies), occurrences: fingerprints(occurrences), history: fingerprints(history), issues: digestPages(issues) });
  return { groupId: view.groupId, algorithm: roster.body.schedulerVersion, timeZone, initialized, range: { ...range }, policy, commonSettings,
    ...(retention ? { historyRetention: { cutoff: retention.cutoff, throughSequence: retention.throughSequence, digest: retainedDigest } } : {}),
    chores, members, dependencies, occurrences, history, issues, sourceHash, planHash };
}
