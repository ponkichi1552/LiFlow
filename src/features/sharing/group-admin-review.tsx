import { router } from 'expo-router';
import { Text } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { SettingsGroup } from '../../components/settings-controls';
import { SettingsRow } from '../settings/settings-navigation';
import { daysBetween, formatJapaneseDate } from '../../domain/scheduling/local-date';
import type { V2GroupController, V2GroupScreenModel } from './v2/controller';
import { V2CompletionHistoryCard } from './v2-ui/completion-history-card';

export function GroupAdminReview({ model, actions, busy, run }: {
  model: V2GroupScreenModel; actions: Pick<V2GroupController['actions'], 'approveSubstitution'>; busy: boolean;
  run(work: () => Promise<unknown>): Promise<void>;
}) {
  if (model.viewerUserId !== model.adminUserId) return null;
  const { plan } = model;
  const names = new Map(plan.chores.map(chore => [chore.id, chore.name]));
  const pending = plan.history.filter(record => record.active && record.outcome === 'completed' && record.acceptance === 'pending');
  const rounds = [...new Map([...plan.occurrences, ...model.calendarLong ?? []].map(round => [round.id, round])).values()]
    .filter(round => round.activeInPeriod).sort((a, b) => Math.abs(daysBetween(plan.range.asOfDate, a.anchorDate)) - Math.abs(daysBetween(plan.range.asOfDate, b.anchorDate)));
  const seenAssignments = new Set<string>();
  const assignments = rounds.filter(round => {
    if (round.claimState !== 'provisional' && !round.assignmentConflictIds.length) return false;
    const key = round.assignmentConflictIds.length ? JSON.stringify([round.choreId, round.assignmentConflictIds]) : round.id;
    if (seenAssignments.has(key)) return false;
    seenAssignments.add(key);
    return true;
  });
  const handledMappings = new Set(assignments.flatMap(round => round.assignmentMappingReviewIds));
  const orphaned = [...new Set(model.orphanedAssignments?.filter(rule => !handledMappings.has(rule.operationId)).map(rule => rule.payload.choreId) ?? [])];
  const dateReviews = rounds.flatMap(round => round.subjects.filter(subject => ['conflict', 'review'].includes(subject.formalDate.kind))
    .map(subject => ({ round, subject })));
  const wasteReview = model.waste?.rows.some(row => !row.deleted && row.needsReview)
    || model.waste?.occurrences.some(row => row.hidden === null);
  if (!pending.length && !assignments.length && !orphaned.length && !dateReviews.length && !wasteReview) {
    return <Text style={{ ...typography.caption, color: palette.muted }}>{formatJapaneseDate(plan.range.from)}〜{formatJapaneseDate(plan.range.through)}に確認が必要な項目はありません。</Text>;
  }
  const assignmentRow = (round: typeof rounds[number]) => <SettingsRow key={round.id} disabled={busy} title={names.get(round.choreId) ?? '共有家事'}
    summary={formatJapaneseDate(round.anchorDate)} onPress={() => router.push({ pathname: '/group-v2/assignment',
      params: { groupId: plan.groupId, occurrenceId: round.id, subjectId: round.subjects[0]?.id, anchorDate: round.anchorDate } })} />;
  return <>
    {pending.length ? <SettingsGroup title="代行の承認">{pending.map(record => <V2CompletionHistoryCard key={record.operationId}
      model={model} record={record} actions={actions} busy={busy} run={run} showDate />)}</SettingsGroup> : null}
    {assignments.length || orphaned.length ? <SettingsGroup title="担当の確認">{assignments.map(assignmentRow)}{orphaned.map(choreId => {
      const target = rounds.find(round => round.choreId === choreId && round.subjects.some(subject => !subject.completed && subject.executionWindowEnd >= plan.range.asOfDate));
      if (target && assignments.some(round => round.id === target.id)) return null;
      return target ? assignmentRow(target) : <Text key={choreId} style={{ ...typography.caption, color: palette.muted }}>
        {names.get(choreId) ?? '以前の家事'} · 対応付け先の回がありません
      </Text>;
    })}</SettingsGroup> : null}
    {dateReviews.length ? <SettingsGroup title="日時の確認">{dateReviews.map(({ round, subject }) =>
      <SettingsRow key={subject.id} title={names.get(round.choreId) ?? '共有家事'} summary={formatJapaneseDate(round.anchorDate)} disabled={busy}
        onPress={() => router.push({ pathname: '/group-v2/date', params: { groupId: plan.groupId, occurrenceId: round.id, subjectId: subject.id, anchorDate: round.anchorDate } })} />)}</SettingsGroup> : null}
    {wasteReview ? <SettingsRow title="ゴミ収集日の確認" disabled={busy} onPress={() => router.push({ pathname: '/group-v2/waste', params: { groupId: plan.groupId } })} /> : null}
  </>;
}
