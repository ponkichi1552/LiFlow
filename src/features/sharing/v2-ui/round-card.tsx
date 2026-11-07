import { v2MemberLabels } from './member-labels';
import { createV2RoundVisibility } from './round-visibility';
import { StyleSheet, Text, View } from 'react-native';
import { AppButton, palette, typography } from '@/components/planner-ui';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { formatJapaneseDate } from '@/domain/scheduling/local-date';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2RoundReference } from '../v2/actions';
import type { V2Recommendation } from '../v2/personal-plan';
import { v2TargetLabel } from './target-form';
import { isTaskUrgent } from '../../../domain/scheduling/task-priority';
import type { CompletionFeedback } from './completion-feedback';

export function V2RoundCard({ model, round, subject, actions, busy, run, onOpen, onDate, onAssignment, onPast, onAssignmentRequest, showActions = false, recommendation, feedback, home = false, compact = false }: {
  model: V2GroupScreenModel; round: V2PlannedOccurrence; subject: V2SubjectPlan; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onOpen: () => void; onDate?: () => void; onAssignment?: () => void;
  onPast?: () => void; onAssignmentRequest?: () => void; showActions?: boolean;
  recommendation?: V2Recommendation;
  feedback?: CompletionFeedback;
  home?: boolean; compact?: boolean;
}) {
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
  const canComplete = owns && round.activeInPeriod && !subject.pendingCompletionIds.length && !subject.dependencyBlocked && !subject.dependencyAwaitingCompletion && !round.assignmentConflictIds.length;
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
  const onToggle = queueable && (work || feedback!.values.has(key)) ? () => feedback!.request!(key, !displayedValue,
    { kind: 'shared', ref, expectedAssigneeIds: subject.subjectUserId === null ? round.assigneeIds : [subject.subjectUserId],
      observedCompletionIds: undo, ...(retainedUndo ? { retainedUndo } : {}) })
    : busy || feedback?.values.has(key) || !work ? undefined : () => feedback
      ? feedback.run(key, subject.completed ? partialUndo : true, work) : run(work);
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
  const needsAttention = round.claimState === 'provisional' || round.assignmentConflictIds.length > 0
    || formal.kind === 'conflict' || formal.kind === 'review' || subject.requestReviewIds.length > 0
    || subject.dependencyAwaitingCompletion || showStatus && (subject.cooldownSuppressed
      || subject.pendingCompletionIds.length > 0 || subject.strictInstructionUnfulfilled);
  const showManualDate = formal.kind === 'manual' && !home;
  const showSourceRegion = formal.kind === 'manual' && formal.timeZone !== model.plan.timeZone;
  const footer = showActions || needsAttention || showManualDate || showSourceRegion ?
    <View style={styles.details}>
      {showActions || showManualDate ? <Text style={styles.date}>{formal.kind === 'manual' ? `${formal.mode === 'fixed' ? '固定日時' : formal.mode === 'deadline' ? '期限' : '実施日'}：${v2TargetLabel(formal.target, formal.timeZone)}`
        : `${recommendation ? '推奨日' : '基準日'}：${formatJapaneseDate(recommendation?.date ?? subject.suggestedDate, { weekday: true })}`}</Text> : null}
      {showSourceRegion && formal.kind === 'manual' ? <Text style={styles.caption}>指定時の地域：{formal.timeZone}。カレンダーの時刻付き予定は現在の地域で表示します。</Text> : null}
      {showActions && (!displayCompleted || recordedWindow) ? <Text style={styles.caption}>{displayCompleted ? '実施時点の期間' : '実施できる期間'}：
        {formatJapaneseDate(displayCompleted && recordedWindow ? recordedWindow.windowStart : subject.executionWindowStart)}〜{formatJapaneseDate(displayCompleted && recordedWindow ? recordedWindow.windowEnd : subject.executionWindowEnd)}</Text> : null}
      {round.claimState === 'provisional' ? <Text style={styles.notice}>引き受けが重なっています。暫定担当のまま実施でき、管理者が正式な担当を決めます。</Text> : null}
      {round.assignmentConflictIds.length ? <Text style={styles.notice}>{round.assignmentMappingReviewIds.length
        ? '周期の変更に合わせて、以前の担当指定をどう適用するか確認してください。' : '担当が競合しています。管理者による確認が必要です。'}</Text> : null}
      {formal.kind === 'conflict' || formal.kind === 'review' || subject.requestReviewIds.length ? <Text style={styles.notice}>日時の確認が必要です。実施した記録は保持されます。</Text> : null}
      {subject.dependencyAwaitingCompletion ? <Text style={styles.notice}>先に必要な家事の完了を待っています。</Text> : null}
      {showStatus && subject.cooldownSuppressed ? <Text style={styles.caption}>最近実施済み · {subject.minimumNextExecutionDay ? formatJapaneseDate(subject.minimumNextExecutionDay) : ''}以降に再実施できます。</Text> : null}
      {showStatus && subject.pendingCompletionIds.length ? <Text style={styles.notice}>実施記録の確認・承認待ち</Text> : null}
      {showStatus && subject.strictInstructionUnfulfilled ? <Text style={styles.notice}>実施済み · 指定日時の条件は未達成です。</Text> : null}
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
  return <TaskCheckboxRow chore={{ ...chore, householdId: '', category }} completed={displayCompleted} home={home} compact={compact} detail={home ? [category, formal.kind === 'manual' ? v2TargetLabel(formal.target, formal.timeZone) : ''].filter(Boolean).join(' · ') : undefined}
      sourceIcon={subject.subjectUserId === null ? 'person' : 'group'} footer={footer}
      action={canClaim ? <View style={styles.claim}><AppButton title="担う" compact variant="quiet" disabled={busy} onPress={() => run(() => actions.claim(ref))} /></View> : undefined}
      source={formal.kind === 'manual' ? 'instructed' : 'shared'}
      executionWindow={{ start: recordedWindow?.windowStart ?? subject.executionWindowStart, end: recordedWindow?.windowEnd ?? subject.executionWindowEnd }}
      urgent={isTaskUrgent({ completed: displayCompleted, load: chore.load, recommendedDate, windowStart: subject.executionWindowStart, windowEnd: subject.executionWindowEnd }, model.plan.range.asOfDate)}
      deemphasized={subject.cooldownSuppressed || subject.virtuallyConsumed} onOpen={onOpen} onToggle={onToggle} />;
}
const styles = StyleSheet.create({
  claim: { borderWidth: 1, borderColor: palette.border, borderRadius: 10, minWidth: 48 },
  details: { gap: 5 },
  date: { ...typography.label, color: palette.ink, fontWeight: '600' }, caption: { ...typography.caption, color: palette.muted },
  notice: { ...typography.caption, color: palette.warning }, buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
