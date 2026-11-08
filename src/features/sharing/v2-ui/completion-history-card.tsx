import { v2MemberLabels } from './member-labels';
import moment from 'moment-timezone';
import { Text, View } from 'react-native';
import { HistoryRecordRow } from '../../../components/history-record-row';
import { SettingsAction } from '../../../components/settings-controls';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2CompletionRecord } from '../v2/completion-history';
import { v2FormStyles as styles } from './form-controls';
import { v2CanShowCompletion } from './round-visibility';

export function V2CompletionHistoryCard({ model, record, actions, busy, run }: {
  model: V2GroupScreenModel; record: V2CompletionRecord; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  grouped?: boolean;
}) {
  if (!record.active || !v2CanShowCompletion(model, record)) return null;
  const admin = model.viewerUserId === model.adminUserId;
  const nameOf = v2MemberLabels(model.plan.members);
  const status = record.outcome === 'incomplete' ? '未実施の記録' : record.approvalConflictIds.length ? '代行の回答が競合しています'
    : record.acceptance === 'pending' ? '代行の承認待ち' : record.acceptance === 'rejected' ? '代行は非承認 · 実施記録は保持' : undefined;
  return <HistoryRecordRow name={model.plan.chores.find((chore) => chore.id === record.choreId)?.name ?? '以前の家事'}
    time={moment(record.performedAt).tz(model.plan.timeZone).format('HH:mm')} status={status}
    attention={record.active && (record.acceptance === 'pending' || record.approvalConflictIds.length > 0)}
    details={<>
    <Text style={styles.caption}>当時の担当者：{record.originalAssigneeIds.length ? record.originalAssigneeIds.map(nameOf).join('・') : '未確定'}</Text>
    <Text style={styles.caption}>実施者：{nameOf(record.performerUserId)}</Text>
    </>}>
    {record.strictInstructionFulfilled === false || (record.acceptance === 'pending' && admin) ? <>
    {record.active && record.strictInstructionFulfilled === false ? <Text style={styles.error}>実施した事実は保存されています。指定日時の条件は未達成です。</Text> : null}
    {record.active && record.acceptance === 'pending' && admin ? <View style={styles.choices}>
      <SettingsAction title="代行の実施を承認" placement="page" disabled={busy} onPress={() => run(() => actions.approveSubstitution(record.operationId, 'approve'))} />
      <SettingsAction title="代行の実施を非承認" placement="page" disabled={busy} onPress={() => run(() => actions.approveSubstitution(record.operationId, 'reject'))} />
    </View> : null}
    </> : null}
  </HistoryRecordRow>;
}
