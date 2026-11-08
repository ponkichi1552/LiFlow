import { v2MemberLabels } from './member-labels';
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Card, SectionHeading } from '../../../components/planner-ui';
import { SettingsAction } from '../../../components/settings-controls';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { v2FormStyles as styles } from './form-controls';
import { v2TargetLabel } from './target-form';

type Props = { model: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean; header?: ReactElement; embedded?: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onResolve?: (occurrenceId: string) => void };
const labels = { pendingDelivery: '端末に保存済み · 申請の送信待ち', awaiting: '管理者の回答待ち', approved: '承認済み', rejected: '拒否されました',
  expired: '期限切れ', tooLate: '受付時に申請期限を過ぎていました', conflict: '回答が競合しています' };

export function V2AssignmentRequests(props: Props) {
  const [visibleCount, setVisibleCount] = useState(8);
  const closed = (request: Props['model']['assignmentRequests'][number]) => request.cancelled || ['approved', 'rejected', 'expired', 'tooLate'].includes(request.kind);
  const entries = props.model.assignmentRequests.filter((request) => props.model.viewerUserId === props.model.adminUserId
    || request.proposal.requesterUserId === props.model.viewerUserId).reverse().sort((a, b) => Number(closed(a)) - Number(closed(b)));
  if (props.embedded) return <View style={{ gap: 12 }}>
    {!entries.length ? <Text style={styles.caption}>申請はありません。</Text> : entries.slice(0, visibleCount).map(request => <AssignmentRequestCard key={request.requestId} {...props} requestId={request.requestId} />)}
    {entries.length > visibleCount ? <SettingsAction placement="page" title="担当変更の申請をさらに表示" compact onPress={() => setVisibleCount(value => value + 8)} /> : null}
  </View>;
  return <FlatList data={entries} keyExtractor={(request) => request.requestId} initialNumToRender={8}
    ListHeaderComponent={props.header} ListEmptyComponent={<Card><Text style={styles.body}>担当の変更申請はありません。</Text></Card>}
    contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
    renderItem={({ item }) => <AssignmentRequestCard {...props} requestId={item.requestId} />} />;
}
function AssignmentRequestCard({ model, actions, busy, run, requestId, onResolve }: Props & { requestId: string }) {
  const liveRequest = model.assignmentRequests.find((request) => request.requestId === requestId)!;
  const liveReview = model.assignmentReviews.find((review) => review.requestId === requestId)!;
  const [displayed, setDisplayed] = useState({ request: liveRequest, review: liveReview });
  const [saved, setSaved] = useState(false); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const inFlight = useRef(false); const { request, review } = displayed;
  const stale = review.revision !== liveReview.revision;
  const disabled = busy || saving || saved || stale || !model.plan.initialized;
  const p = request.proposal; const nameOf = v2MemberLabels(model.plan.members);
  const currentRound = model.plan.occurrences.find((round) => round.id === p.occurrenceId);
  const resolved = request.kind === 'conflict' && Boolean(currentRound)
    && !currentRound!.assignmentConflictIds.some((id) => request.conflictIds.includes(id))
    && model.assignmentRules.some((fact) => fact.payload.reviewedAssignmentRequestIds?.includes(requestId)
      && (fact.payload.scope === 'once' ? fact.payload.fromOccurrenceId === p.occurrenceId : fact.payload.fromAnchorDate <= p.anchorDate));
  const label = (target: Parameters<typeof v2TargetLabel>[0]) => v2TargetLabel(target, p.timeZone, { includeYear: true });
  const answer = async (decision: 'approve' | 'reject') => {
    if (disabled || !review.canVote || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError(null);
    try { await run(async () => {
      try { await actions.answerAssignment(requestId, decision, { expectedReviewRevision: review.revision }); setSaved(true); }
      catch (cause) { setError(cause instanceof Error && 'code' in cause && cause.code === 'sharing/v2-authority-denied'
        ? '担当・メンバーまたは権限が変わっています。現在の家事回を確認してください。' : cause instanceof Error ? cause.message : '担当変更の回答を保存できませんでした。'); }
    }); } finally { inFlight.current = false; setSaving(false); }
  };
  return <Card><SectionHeading title={model.plan.chores.find((chore) => chore.id === p.choreId)?.name ?? '担当変更の申請'} />
    <Text style={styles.caption}>申請者：{nameOf(p.requesterUserId)}</Text>
    <Text style={styles.body}>変更前の担当：{p.originalMemberIds.map(nameOf).join('・') || '担当未確定'}</Text>
    <Text style={styles.body}>申請した担当：{p.memberIds.map(nameOf).join('・') || '担当未確定'}{p.fixed ? '（管理者による固定）' : ''}</Text>
    <Text style={styles.caption}>適用する基準日：{p.anchorDate}{p.scope === 'once' ? '（この回だけ）' : 'から'}</Text>
    <Text style={styles.caption}>申請時の正式日時：{label(p.reference)} · {p.timeZone}</Text>
    <Text style={styles.body}>{request.cancelled ? 'この申請の担当指定は解除済みです。回答と実施履歴は保持しています。' : labels[request.kind]}</Text>
    {resolved ? <Text style={styles.caption}>管理者による担当指定で確認済みです。元の回答は履歴に残しています。他のメンバーへの反映は同期状態で確認できます。</Text> : null}
    {request.deadline.kind === 'open' ? <Text style={styles.caption}>回答期限：{label({ precision: 'instant', at: new Date(request.deadline.expiresAt).toISOString() })}</Text> : null}
    {review.answers.map((item) => <Text key={item.operationId} style={styles.caption}>{nameOf(item.authorUserId)}：{item.decision === 'approve' ? '承認' : '拒否'} ·
      {item.kind === 'pendingDelivery' ? '送信待ち' : item.kind === 'eligible' ? '受付確認済み' : item.kind === 'late' ? '期限後の回答' : item.kind === 'requestClosed' ? '締切後の回答' : '受付済み'}</Text>)}
    {liveReview.pendingAnswer ? <Text style={styles.caption}>回答の送信待ちです。回答を端末に保存しています。正式な担当は受付確認後に判定します。期限後に届いた承認で元の申請を自動確定しません。</Text> : null}
    {saved ? <Text accessibilityLiveRegion="polite" style={styles.body}>回答を端末に保存しました。受付確認までは元の担当を維持します。</Text> : null}
    {stale ? <Text accessibilityRole="alert" style={styles.error}>回答・担当・日時・周期または権限が変わっています。現在の状態：{labels[liveRequest.kind]}。最新の内容を確認してください。</Text> : null}
    {stale || saved ? <SettingsAction placement="page" title="最新の担当申請を表示" disabled={busy || saving} onPress={() => {
      if (inFlight.current) return; setDisplayed({ request: liveRequest, review: liveReview }); setSaved(false); setError(null);
    }} /> : null}
    {review.canVote ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <SettingsAction placement="page" title="担当変更を承認" intent="primary" disabled={disabled} onPress={() => answer('approve')} />
      <SettingsAction placement="page" title="担当変更を拒否" intent="destructive" disabled={disabled} onPress={() => answer('reject')} />
    </View> : null}
    {review.canResolve && !resolved ? <><Text style={styles.error}>異なる回答を保持しています。管理者が対象の家事回で正式な担当を確認して解決します。</Text>
      {onResolve ? <SettingsAction placement="page" title="家事回で担当の競合を解決" disabled={disabled || !model.plan.occurrences.some((round) => round.id === p.occurrenceId)} onPress={() => onResolve(p.occurrenceId)} /> : null}
      {!model.plan.occurrences.some((round) => round.id === p.occurrenceId) ? <Text style={styles.caption}>対象の家事回が表示期間外です。期間を変えて確認してください。</Text> : null}</> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </Card>;
}
