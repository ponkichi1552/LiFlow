import { v2MemberLabels } from './member-labels';
import { createV2RoundVisibility } from './round-visibility';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppButton, palette, typography } from '@/components/planner-ui';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { formatJapaneseDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2RoundReference } from '../v2/actions';
import type { V2Recommendation } from '../v2/personal-plan';
import { v2TargetLabel } from './target-form';
import { isTaskUrgent } from '../../../domain/scheduling/task-priority';
import type { CompletionFeedback } from './completion-feedback';
import { v2BacklogTarget } from './backlog-target';
import { calendarChoreTimeLabel } from '../../calendar/chore-time-label';

export function V2RoundCard({ model, round: displayedRound, subject: displayedSubject, actions, busy, run, onOpen, onDate, onAssignment, onPast, onAssignmentRequest, showActions = false, recommendation: displayedRecommendation, feedback, home = false, homeDate = model.plan.range.asOfDate, compact = false, narrowCalendar, mixedSources = false, showCalendarTime = false, showHomeSource = false, overdue = false }: {
  model: V2GroupScreenModel; round: V2PlannedOccurrence; subject: V2SubjectPlan;
  actions: Pick<V2GroupController['actions'], 'complete' | 'undoMany' | 'claim' | 'releaseClaim' | 'requestAssignment'>; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onOpen: () => void; onDate?: () => void; onAssignment?: () => void;
  onPast?: () => void; onAssignmentRequest?: () => void; showActions?: boolean;
  recommendation?: V2Recommendation;
  feedback?: CompletionFeedback;
  home?: boolean; homeDate?: LocalDate; compact?: boolean; narrowCalendar?: 'three' | 'week'; mixedSources?: boolean; showCalendarTime?: boolean; showHomeSource?: boolean; overdue?: boolean;
}) {
  const { round, subject } = showActions ? { round: displayedRound, subject: displayedSubject } : v2BacklogTarget(model.plan.occurrences, displayedRound, displayedSubject, model.plan.range.asOfDate);
  const recommendation = subject.id === displayedSubject.id ? displayedRecommendation : undefined;
  const chore = model.plan.chores.find((entry) => entry.id === round.choreId); if (!chore) return null;
  const viewer = model.viewerUserId;
  const { admin, owns, relatedWork, showStatus } = createV2RoundVisibility(model)(round, subject);
  const nameOf = v2MemberLabels(model.plan.members);
  const undo = subject.completionOperationIds.filter((id) => relatedWork.some((record) => record.operationId === id && record.active && (admin || record.recorderUserId === viewer)));
  const retainedUndoIds = subject.retainedCompletion?.recorderUserIds.filter(uid => admin || uid === viewer) ?? [];
  const retainedUndo = retainedUndoIds.length && subject.retainedCompletion ? { choreId: round.choreId, anchorDate: round.anchorDate, subjectUserId: subject.subjectUserId,
    checkpointId: subject.retainedCompletion.checkpointId, recorderUserIds: retainedUndoIds } : undefined;
  const partialUndo = undo.length < subject.completionOperationIds.length || retainedUndoIds.length < (subject.retainedCompletion?.recorderUserIds.length ?? 0);
  const ref: V2RoundReference = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: subject.subjectUserId,
    expectedConfigurationIds: model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId), expectedTimeZone: model.plan.timeZone };
  // Dependencies guide scheduling. Completion records work the member already did.
  const canComplete = owns && round.activeInPeriod && !subject.pendingCompletionIds.length && !round.assignmentConflictIds.length;
  const key = `shared:${subject.id}`;
  const work = subject.completed ? undo.length || retainedUndo ? () => actions.undoMany(undo, retainedUndo) : undefined
    : canComplete ? async () => {
      const created = await actions.complete(ref, { expectedAssigneeIds: subject.subjectUserId === null ? round.assigneeIds : [subject.subjectUserId] });
      const own = (created ?? []).filter(op => op.entityType === 'completion' && op.operationType === 'complete' && op.authorUserId === viewer);
      return own.length ? { undo: () => actions.undoMany(own.map(op => op.operationId)) } : undefined;
    } : undefined;
  const displayedValue = feedback?.values.get(key) ?? subject.completed;
  // A partial undo must keep another member's completion visible. Its existing
  // receipt path preserves that distinction; ordinary toggles use the durable queue.
  const queueable = feedback?.supports?.('shared') && feedback.request && !partialUndo;
  const queuedToggle = queueable && (work || feedback!.values.has(key)) ? () => feedback!.request!(key, !displayedValue,
    { kind: 'shared', ref, expectedAssigneeIds: subject.subjectUserId === null ? round.assigneeIds : [subject.subjectUserId],
      observedCompletionIds: undo, ...(retainedUndo ? { retainedUndo } : {}) }) : undefined;
  const onToggle = queuedToggle ?? (busy || feedback?.values.has(key) || !work ? undefined : () => feedback
    ? feedback.run(key, subject.completed ? partialUndo : true, work) : run(work));
  const category = subject.subjectUserId ? nameOf(subject.subjectUserId) : round.assigneeIds.length
    ? `${round.claimState === 'provisional' ? '暫定：' : ''}${round.assigneeIds.map(nameOf).join('・')}` : '';
  const formal = subject.formalDate;
  const schedules = relatedWork.filter((record) => record.active && record.schedule).map((record) => record.schedule!);
  const recordedWindow = subject.completed && schedules.length && schedules.every((schedule) => schedule.windowStart === schedules[0].windowStart && schedule.windowEnd === schedules[0].windowEnd) ? schedules[0] : null;
  const displayCompleted = showStatus && displayedValue;
  const recommendedDate = recommendation?.date ?? subject.suggestedDate;
  const assignmentPending = model.assignmentRequests.some((request) => !request.cancelled && request.proposal.occurrenceId === round.id && request.proposal.requesterUserId === viewer
    && ['pendingDelivery', 'awaiting'].includes(request.kind));
  const canClaim = round.configuration.policy.completion === 'one' && !round.assigneeIds.length && !subject.completed && !round.assignmentConflictIds.length;
  const cooldown = showStatus && subject.cooldownSuppressed ? subject.minimumNextExecutionDay : null;
  const showCooldown = !home && cooldown;
  const showManualDate = formal.kind === 'manual' && !home && !cooldown;
  const showSourceRegion = !home && formal.kind === 'manual' && formal.timeZone !== model.plan.timeZone;
  const homeTarget = home && formal.kind === 'manual' && !cooldown
    ? v2TargetLabel(formal.target, model.plan.timeZone, { referenceDate: homeDate }) : undefined;
  const homeDetail = homeTarget !== undefined && formal.kind === 'manual' && formal.mode === 'deadline'
    ? `${homeTarget || '今日'}まで` : homeTarget;
  const footer = showActions || showCooldown || showManualDate || showSourceRegion ?
    <View style={styles.details}>
      {showActions || showManualDate ? <Text style={styles.date}>{formal.kind === 'manual' ? `${formal.mode === 'fixed' ? '固定日時' : formal.mode === 'deadline' ? '期限' : '実施日'}：${v2TargetLabel(formal.target, formal.timeZone)}`
        : `${recommendation ? '推奨日' : '基準日'}：${formatJapaneseDate(recommendation?.date ?? subject.suggestedDate, { weekday: true })}`}</Text> : null}
      {showSourceRegion && formal.kind === 'manual' ? <Text style={styles.caption}>指定時の地域：{formal.timeZone}。カレンダーの時刻付き予定は現在の地域で表示します。</Text> : null}
      {showActions && (!displayCompleted || recordedWindow) ? <Text style={styles.caption}>{displayCompleted ? '実施時点の期間' : '実施できる期間'}：
        {formatJapaneseDate(displayCompleted && recordedWindow ? recordedWindow.windowStart : subject.executionWindowStart)}〜{formatJapaneseDate(displayCompleted && recordedWindow ? recordedWindow.windowEnd : subject.executionWindowEnd)}</Text> : null}
      {showCooldown ? <Text style={styles.caption}>再実施の目安は{formatJapaneseDate(showCooldown)}以降</Text> : null}
      {showActions && showStatus && subject.pendingCompletionIds.length ? <Text style={styles.caption}>代行を記録済み</Text> : null}
      {showActions && showStatus && subject.completed && relatedWork.some(record => record.active) ? <Text style={styles.caption}>実施者：{[...new Set(relatedWork.filter((record) => record.active).map((record) => nameOf(record.performerUserId)))].join('・')}</Text> : null}
      {showActions && showStatus && subject.completed && partialUndo ? <Text style={styles.caption}>ほかの人が登録した完了は、その登録者か管理者が取り消せます。</Text> : null}
      <View style={styles.buttons}>
        {showActions && onDate ? <AppButton title="日時を変更" compact variant="secondary" disabled={busy || !round.activeInPeriod || Boolean(round.assignmentConflictIds.length)} onPress={onDate} /> : null}
        {showActions && onPast && !subject.completed ? <AppButton title={owns ? '以前の実施を記録' : model.plan.policy?.allowSubstitution ? '代行を記録' : '代行を記録（承認が必要）'} compact variant="quiet" disabled={busy || Boolean(round.assignmentConflictIds.length)} onPress={onPast} /> : null}
        {showActions && onAssignment && admin ? <AppButton title={round.assignmentConflictIds.length ? '担当の競合を解決' : round.claimState === 'provisional' ? '暫定担当を確認' : '担当を変更'} compact variant="quiet" disabled={busy} onPress={onAssignment} /> : null}
        {showActions && !subject.completed && round.claimantUserIds.includes(viewer) && !round.assignmentFixed
          ? <AppButton title="担当を外す" compact variant="quiet" disabled={busy} onPress={() => run(() => actions.releaseClaim(ref))} /> : null}
        {showActions && !admin && round.assignmentFixed && owns && !subject.completed ? <AppButton title={assignmentPending ? '担当変更を申請中' : onAssignmentRequest ? '担当の変更を申請' : '自分の担当解除を申請'} compact variant="quiet" disabled={busy || assignmentPending}
          onPress={onAssignmentRequest ?? (() => run(() => { const remaining = round.assigneeIds.filter((uid) => uid !== viewer); return actions.requestAssignment(ref,
            { memberIds: remaining, start: 'this', scope: 'once', fixed: remaining.length > 0 && round.assignmentFixed,
              expectedAssignmentIds: round.assignmentOperationIds, expectedConflictIds: round.assignmentConflictIds }); }))} /> : null}
      </View>
    </View> : undefined;
  return <TaskCheckboxRow chore={{ ...chore, householdId: '', category }} completed={displayCompleted} home={home} compact={compact} narrowCalendar={narrowCalendar} mixedSources={mixedSources}
      detail={homeDetail}
      homeSourceLabel={showHomeSource ? '共有' : undefined} overdue={overdue && formal.kind !== 'manual'}
      calendarTimeLabel={showCalendarTime && formal.kind === 'manual' && formal.mode === 'fixed' && formal.target.precision === 'interval'
        ? calendarChoreTimeLabel({ start: Date.parse(formal.target.start), end: Date.parse(formal.target.end) }, model.plan.timeZone) : undefined}
      footer={footer}
      action={canClaim ? <Pressable accessibilityRole="button" accessibilityLabel="担う" accessibilityHint="この家事を引き受けます"
        disabled={busy} onPress={() => run(() => actions.claim(ref))} style={styles.claimTarget}>
        {({ pressed }) => <View style={[styles.claim, pressed && styles.claimPressed, busy && styles.claimDisabled]}><Text style={styles.claimText}>担う</Text></View>}
      </Pressable> : undefined}
      source={formal.kind === 'manual' ? 'instructed' : 'shared'}
      executionWindow={{ start: recordedWindow?.windowStart ?? subject.executionWindowStart, end: recordedWindow?.windowEnd ?? subject.executionWindowEnd }}
      urgent={isTaskUrgent({ completed: displayCompleted, load: chore.load, recommendedDate, windowStart: subject.executionWindowStart, windowEnd: subject.executionWindowEnd }, model.plan.range.asOfDate)}
      deemphasized={subject.cooldownSuppressed || subject.virtuallyConsumed} onOpen={onOpen} onToggle={onToggle} immediateCheckbox={Boolean(queuedToggle)}
      onChangeDate={compact && !displayCompleted ? onDate : undefined} />;
}
const styles = StyleSheet.create({
  claimTarget: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  claim: { borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, borderRadius: 7, paddingHorizontal: 6, paddingVertical: 3 },
  claimText: { ...typography.caption, color: palette.accent, fontWeight: '600' },
  claimPressed: { backgroundColor: palette.accentSoft }, claimDisabled: { opacity: .5 },
  details: { gap: 5 },
  date: { ...typography.label, color: palette.ink, fontWeight: '600' }, caption: { ...typography.caption, color: palette.muted },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
