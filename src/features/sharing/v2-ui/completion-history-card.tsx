import { v2MemberLabels } from './member-labels';
import moment from 'moment-timezone';
import { Text, View } from 'react-native';
import { AppButton, Card, SectionHeading } from '../../../components/planner-ui';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2CompletionRecord } from '../v2/completion-history';
import { v2FormStyles as styles } from './form-controls';
import { v2CanShowCompletion } from './round-visibility';
import { v2TargetLabel } from './target-form';

export function V2CompletionHistoryCard({ model, record, actions, busy, run, grouped = false }: {
  model: V2GroupScreenModel; record: V2CompletionRecord; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  grouped?: boolean;
}) {
  if (!v2CanShowCompletion(model, record)) return null;
  const admin = model.viewerUserId === model.adminUserId;
  const nameOf = v2MemberLabels(model.plan.members);
  const date = (at: string) => moment(at).tz(model.plan.timeZone).format('YYYY年M月D日 HH:mm');
  const status = !record.active ? '取消済み' : record.outcome === 'incomplete' ? '未実施の記録' : record.approvalConflictIds.length ? '代行の回答が競合しています'
    : record.acceptance === 'pending' ? '代行の承認待ち' : record.acceptance === 'rejected' ? '代行は非承認 · 実施記録は保持' : '実施済み';
  return <Card><SectionHeading title={model.plan.chores.find((chore) => chore.id === record.choreId)?.name ?? '以前の家事'} />
    <Text style={styles.body}>{status}</Text>
    <Text style={styles.body}>実施：{grouped ? moment(record.performedAt).tz(model.plan.timeZone).format('HH:mm') : date(record.performedAt)}</Text>
    <Text style={styles.caption}>実施者：{nameOf(record.performerUserId)}</Text>
    <Text style={styles.caption}>本来の担当：{record.originalAssigneeIds.length ? record.originalAssigneeIds.map(nameOf).join('・') : '担当未確定'}</Text>
    <Text style={styles.caption}>登録者：{nameOf(record.recorderUserId)}</Text>
    <Text style={styles.caption}>登録：{date(record.recordedAt)} · {model.plan.timeZone}</Text>
    {record.instruction?.kind === 'designated' ? <Text style={styles.caption}>実施時点の指定：{v2TargetLabel(record.instruction.target, record.instruction.timeZone, { includeYear: true })} · {record.instruction.timeZone}</Text> : null}
    {record.active && record.strictInstructionFulfilled === false ? <Text style={styles.error}>実施した事実は保存されています。指定日時の条件は未達成です。</Text> : null}
    {record.active && record.acceptance === 'pending' && admin ? <View style={styles.choices}>
      <AppButton title="代行の実施を承認" compact disabled={busy} onPress={() => run(() => actions.approveSubstitution(record.operationId, 'approve'))} />
      <AppButton title="代行の実施を非承認" compact variant="secondary" disabled={busy} onPress={() => run(() => actions.approveSubstitution(record.operationId, 'reject'))} />
    </View> : null}
    {record.active && (admin || record.recorderUserId === model.viewerUserId) ? <AppButton title="この完了を取り消す" compact variant="secondary" disabled={busy}
      onPress={() => run(() => actions.undo(record.operationId))} /> : null}
  </Card>;
}
