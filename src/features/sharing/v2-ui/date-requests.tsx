import { v2MemberLabels } from './member-labels';
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FlatList, Platform, Text, View } from 'react-native';
import { Card, SectionHeading } from '../../../components/planner-ui';
import { SettingsAction } from '../../../components/settings-controls';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2DateDecision } from '../v2/decision-review';
import type { DateTarget } from '../v2/model';
import type { V2DateRequestState } from '../v2/request-state';
import { canonicalJson } from '../operations';
import { V2ActionConfirmationError } from '../v2/actions';
import type { CalendarConflict } from '../v2/private-availability';
import { v2FormStyles as styles } from './form-controls';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { V2DateTargetFields } from './date-target-fields';
import { v2InitialTargetFields, v2TargetFromEditedForm, v2TargetLabel } from './target-form';
import { V2DateConfirmation } from './date-confirmation';
import type { V2DateConfirmationKind } from './date-confirmation';

type Props = { model: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean; header?: ReactElement; embedded?: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; readOwnCalendar?: (target: DateTarget) => Promise<CalendarConflict> };
const labels: Record<V2DateRequestState['kind'], string> = {
  pendingDelivery: '端末に保存済み · 申請の送信待ち', awaiting: '必要な回答を待っています', counteroffered: '代替日時が提案されています',
  approved: '承認済み', rejected: '拒否されました', expired: '期限切れ', tooLate: '受付時に申請期限を過ぎていました',
  blocked: '日時の制約により確定できません', conflict: '回答が競合しています',
};
const answerLabels: Record<V2DateDecision, string> = { approve: '承認', reject: '拒否', counteroffer: '代替日時の提案', acceptCounteroffer: '代替日時の承諾' };

export function V2DateRequests(props: Props) {
  const [visibleCount, setVisibleCount] = useState(8);
  const closed = (request: V2DateRequestState) => ['approved', 'rejected', 'expired', 'tooLate', 'blocked'].includes(request.kind);
  const entries = [...props.model.requests].reverse().sort((a, b) => Number(closed(a)) - Number(closed(b)));
  if (props.embedded) return <View style={{ gap: 12 }}>
    {!entries.length ? <Text style={styles.caption}>申請はありません。</Text> : entries.slice(0, visibleCount).map(request => <DateRequestCard key={request.requestId} {...props} requestId={request.requestId} />)}
    {entries.length > visibleCount ? <SettingsAction placement="page" title="日時変更の申請をさらに表示" compact onPress={() => setVisibleCount(value => value + 8)} /> : null}
  </View>;
  return <FlatList data={entries} keyExtractor={(request) => request.requestId} initialNumToRender={8}
    automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
    ListHeaderComponent={props.header} ListEmptyComponent={<Card><Text style={styles.body}>日時の変更申請はありません。</Text></Card>}
    renderItem={({ item }) => <DateRequestCard {...props} requestId={item.requestId} />} />;
}

/** The displayed request and its review revision stay together until the user explicitly reloads. */
function DateRequestCard({ model, actions, busy, run, requestId, readOwnCalendar }: Props & { requestId: string }) {
  const liveRequest = model.requests.find((request) => request.requestId === requestId)!;
  const liveReview = model.requestReviews.find((review) => review.requestId === requestId)!;
  const [displayed, setDisplayed] = useState(() => ({ request: liveRequest, review: liveReview }));
  const [draft, setDraft] = useState(() => ({ offerOpen: false, reviewed: false, fields: v2InitialTargetFields(liveRequest.proposal.proposed, liveRequest.timeZone) }));
  const input = useRef(draft); const inFlight = useRef(false);
  const inputRevision = useRef(0); const confirmed = useRef({ recentWork: false, highLoad: false, calendar: false });
  const confirmedFor = useRef<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: V2DateConfirmationKind; decision: V2DateDecision; referenceDecisionId: string | null; revision: number } | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<{ target: DateTarget; kind: CalendarConflict['kind'] } | null>(null);
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false); const [error, setError] = useState<string | null>(null);
  const request = displayed.request; const review = displayed.review;
  const stale = review.revision !== liveReview.revision;
  const previousRegion = request.timeZone !== model.plan.timeZone;
  const disabled = busy || saving || stale || saved || !model.plan.initialized;
  const canAnswer = !disabled && (request.kind !== 'conflict' || draft.reviewed);
  const nameOf = v2MemberLabels(model.plan.members);
  const resetConfirmation = () => { setConfirmation(null); setCalendarStatus(null); confirmedFor.current = null; confirmed.current = { recentWork: false, highLoad: false, calendar: false }; };
  const edit = (patch: Partial<typeof draft>) => { if (inFlight.current) return; inputRevision.current++; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); resetConfirmation(); };
  const field = (name: keyof typeof draft.fields, value: string) => edit({ fields: { ...input.current.fields, [name]: value,
    ...(['day', 'clock'].includes(name) ? { clockChoice: '' } : ['endDay', 'endClock'].includes(name) ? { endClockChoice: '' } : {}) } });
  const answer = async (decision: V2DateDecision, referenceDecisionId: string | null = null) => {
    if (disabled || inFlight.current) return;
    if (request.kind === 'conflict' && !input.current.reviewed) { setError('競合している回答を確認してください。'); return; }
    let target: DateTarget | null = null;
    try {
      if (decision === 'counteroffer') target = v2TargetFromEditedForm({ mode: request.proposal.proposedMode, ...input.current.fields,
        timeZone: request.timeZone }, request.proposal.proposed, v2InitialTargetFields(request.proposal.proposed, request.timeZone));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '代替日時を確認してください。'); return; }
    const ask = (kind: V2DateConfirmationKind) => setConfirmation({ kind, decision, referenceDecisionId, revision: inputRevision.current });
    const offer = request.counteroffers.find((entry) => entry.operationId === referenceDecisionId);
    const chosen = decision === 'approve' ? request.proposal.proposed : decision === 'counteroffer' ? target : offer?.target;
    const actionKey = canonicalJson({ decision, referenceDecisionId, chosen: chosen ?? null, inputRevision: inputRevision.current, review: review.revision });
    if (confirmedFor.current !== actionKey) { resetConfirmation(); confirmedFor.current = actionKey; }
    const round = model.plan.occurrences.find((entry) => entry.id === request.proposal.occurrenceId);
    const assignees = round?.subjects.find((entry) => entry.subjectUserId === request.proposal.subjectUserId)?.assigneeIds ?? [];
    inFlight.current = true; setSaving(true); setError(null);
    try { await run(async () => {
      if (chosen && request.proposal.proposedMode === 'fixed' && assignees.includes(model.viewerUserId) && readOwnCalendar && !confirmed.current.calendar) {
        const reading = await readOwnCalendar(chosen); setCalendarStatus({ target: chosen, kind: reading.kind });
        if (reading.kind === 'conflict') { ask('calendar'); return; }
      }
      try { await actions.decide(requestId, decision, target, referenceDecisionId, { expectedReviewRevision: review.revision,
        confirmRecentWork: confirmed.current.recentWork, confirmHighLoad: confirmed.current.highLoad }); }
      catch (cause) {
        if (cause instanceof V2ActionConfirmationError) { ask(cause.reason); return; }
        if (cause instanceof Error && 'code' in cause && cause.code === 'sharing/v2-authority-denied') {
          setError('申請後に担当・固定日時・実施順序や権限が変わっています。現在の家事回を確認し、必要なら申請し直してください。'); return;
        }
        setError(cause instanceof Error ? cause.message : '回答を保存できませんでした。入力を確認してください。'); return;
      }
      setSaved(true); setConfirmation(null);
    }); } finally { inFlight.current = false; setSaving(false); }
  };
  const reload = () => {
    if (busy || inFlight.current) return;
    setDisplayed({ request: liveRequest, review: liveReview }); setSaved(false); setError(null);
    inputRevision.current++; resetConfirmation();
    input.current = { offerOpen: false, reviewed: false, fields: v2InitialTargetFields(liveRequest.proposal.proposed, liveRequest.timeZone) }; setDraft(input.current);
  };
  const removal = request.proposal.cancellation;
  const selector = removal ? removal.selector : request.proposal.selector;
  const removalSources = removal ? (model.dateRuleSources ?? model.dateRules).filter((fact) => removal.targetOperationIds.includes(fact.operationId)) : [];
  const label = (target: DateTarget) => v2TargetLabel(target, request.timeZone, { includeYear: true });
  return <Card><SectionHeading title={model.plan.chores.find((chore) => chore.id === request.proposal.choreId)?.name ?? '日時変更の申請'} />
    {removal ? <Text style={styles.body}>日時指定の解除申請</Text> : null}
    <Text style={styles.caption}>申請者：{nameOf(request.proposal.requesterUserId)} · 日時の地域：{request.timeZone}</Text>
    <Text style={styles.body}>{request.kind === 'approved' ? '変更前の日時' : '正式な日時'}：{request.original ? v2TargetLabel(request.original, request.originalTimeZone, { includeYear: true }) : '元の時刻が存在しないため未確定'}</Text>
    {request.originalTimeZone !== request.timeZone ? <Text style={styles.caption}>元の指定の地域：{request.originalTimeZone}</Text> : null}
    <Text style={styles.body}>{removal ? '解除後の期限計算の基準' : '申請した日時'}：{v2TargetLabel(request.proposal.proposed, request.proposedTimeZone, { includeYear: true })}</Text>
    {removal && request.proposedTimeZone !== request.timeZone ? <Text style={styles.caption}>残る指定の地域：{request.proposedTimeZone}</Text> : null}
    {removal ? <Text style={styles.caption}>この申請で新しい手動日時は指定しません。解除後は残る指定、または自動計算した予定を適用します。</Text>
      : <Text style={styles.caption}>指定の種類：{request.proposal.proposedMode === 'fixed' ? '固定日時に実施' : request.proposal.proposedMode === 'deadline' ? '期限までに実施' : 'この日に実施'}</Text>}
    <Text style={styles.caption}>適用範囲：{!selector ? '表示した元指定の全期間' : selector.scope === 'once' ? `今回だけ（基準日 ${selector.anchorDate}）` : selector.scope === 'ongoing' ? `${selector.from}から無期限` : `${selector.range.from}〜${selector.range.through ?? '無期限'}`}</Text>
    {removalSources.map((fact) => <Text key={fact.operationId} style={styles.caption}>解除する元指定：{fact.rule.selector.scope === 'once' ? fact.rule.selector.anchorDate
      : fact.rule.selector.scope === 'period' ? `${fact.rule.selector.range.from}〜${fact.rule.selector.range.through ?? '無期限'}` : `${fact.rule.selector.from}から無期限`}</Text>)}
    {!removal ? <Text style={styles.caption}>承認後の期間拡張：{request.proposal.extensionScope === 'future' ? '今後の家事回にも適用' : '今回の家事回だけ'}</Text> : null}
    <Text style={styles.caption}>{removal ? '解除後に残る条件' : '申請した条件'}：{[
      request.proposal.proposedOptions.strict ? '指定日時を厳守' : null, request.proposal.proposedOptions.adminLocked ? '管理者による固定' : null,
      request.proposal.proposedOptions.forbidEarlier ? '前倒しを禁止' : null, request.proposal.proposedOptions.allowDuringCooldown ? '最近の実施があっても再指定' : null,
    ].filter(Boolean).join('・') || '追加条件なし'}</Text>
    <Text style={styles.body}>{labels[request.kind]}</Text>
    {request.deadline.kind === 'open' ? <Text style={styles.caption}>回答期限：{label({ precision: 'instant', at: new Date(request.deadline.expiresAt).toISOString() })}</Text> : null}
    {request.kind === 'approved' && request.formalAction === 'cancel' ? <Text style={styles.body}>選択した範囲の日時指定を解除しました。実施履歴は保持されています。</Text>
      : request.kind === 'approved' && request.formal ? <><Text style={styles.body}>確定した日時：{label(request.formal)}</Text>
      {request.formalOptions?.allowDuringCooldown ? <Text style={styles.caption}>確定した条件：最近の実施があっても再指定します。</Text> : null}</>
      : <Text style={styles.caption}>必要な承認の受付確認までは元の正式予定を維持します。端末時計による自動承認はしません。</Text>}
    {review.answers.map((item) => <Text key={item.operationId} style={styles.caption}>{nameOf(item.authorUserId)}：{answerLabels[item.decision]}
      {item.target ? ` · ${label(item.target)}` : ''}{item.allowDuringCooldown ? ' · 最近の実施があっても再指定' : ''} · {item.kind === 'pendingDelivery' ? '送信待ち' : item.kind === 'eligible' ? '受付確認済み' : item.kind === 'late' ? '期限後の回答' : item.kind === 'requestClosed' ? '締切後の回答' : item.kind === 'staleCounteroffer' ? '旧代替案への回答' : item.kind === 'unauthorized' ? '権限を確認できません' : item.kind === 'invalidCausality' ? '回答の前提を確認できません' : '受付済み'}</Text>)}
    {review.pendingAnswer ? <Text style={styles.caption}>回答を端末に保存しています。{['expired', 'tooLate', 'rejected', 'blocked'].includes(request.kind)
      ? '送信待ちの回答は履歴に残し、この申請を自動で承認済みに戻しません。' : '正式な承認はサーバーの受付後に判定します。'}</Text> : null}
    {saved ? <Text accessibilityLiveRegion="polite" style={styles.body}>回答を端末に保存しました。正式な確定は受付と必要な同意の確認後です。</Text> : null}
    {stale ? <Text accessibilityRole="alert" style={styles.error}>別の回答・設定・権限の変更が届いています。入力は保持しています。最新の状態：{labels[liveRequest.kind]}。最新の内容を確認してから回答してください。</Text> : null}
    {previousRegion ? <Text style={styles.caption}>この申請と回答は申請時の地域（{request.timeZone}）を維持します。現在のグループ地域は{model.plan.timeZone}です。</Text> : null}
    {!model.plan.initialized ? <Text style={styles.error}>地域・共通設定を確認してから回答してください。</Text> : null}
    {stale || saved ? <SettingsAction placement="page" title="最新の申請内容を表示" disabled={busy || saving} onPress={reload} /> : null}
    {request.kind === 'conflict' ? <><Text style={styles.error}>異なる回答を保持しています。表示した回答を確認してから解決してください。到着順では決めません。</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Text style={[styles.label, { flex: 1 }]}>競合している回答を確認した</Text>
        <SettingsCheckbox accessibilityLabel="競合している回答を確認した" value={draft.reviewed} disabled={disabled} onValueChange={(reviewed) => edit({ reviewed })} /></View></> : null}
    {review.canVote ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <SettingsAction placement="page" title={removal ? '日時指定の解除を承認' : '日時変更を承認'} intent="primary" compact disabled={!canAnswer} onPress={() => answer('approve')} />
      <SettingsAction placement="page" title={removal ? '解除申請を拒否' : '日時変更を拒否'} intent="destructive" compact disabled={!canAnswer} onPress={() => answer('reject')} />
    </View> : null}
    {request.counteroffers.map((offer) => <View key={offer.operationId} style={{ gap: 8 }}>
      <Text style={styles.body}>代替日時：{label(offer.target)}</Text>
      {offer.options.allowDuringCooldown ? <Text style={styles.caption}>最近の実施があっても再指定する条件を含みます。本人の承諾まで確定しません。</Text> : null}
      <Text style={styles.caption}>承諾期限：{label({ precision: 'instant', at: new Date(offer.expiresAt).toISOString() })}。必要な本人の承諾で確定し、管理者へ再承認は求めません。</Text>
      {review.acceptableCounterofferIds.includes(offer.operationId) ? <SettingsAction placement="page" title={`この代替日時を承諾（${label(offer.target)}）`} disabled={!canAnswer} onPress={() => answer('acceptCounteroffer', offer.operationId)} /> : null}
    </View>)}
    {review.canCounteroffer ? draft.offerOpen ? <View style={{ gap: 10 }}><SectionHeading title="代替日時を提案" />
      <Text style={styles.caption}>{removal ? '解除の代わりに手動日時を指定する提案です。本人が承諾すると、その日時指定が残ります。' : '指定の種類・適用範囲・条件は上記の申請を引き継ぎます。'}入力だけでは保存しません。</Text>
      <V2DateTargetFields mode={request.proposal.proposedMode} fields={draft.fields} timeZone={request.timeZone} disabled={disabled} onChange={field} />
      <SettingsAction placement="page" title="この日時を代替案として送る" intent="primary" disabled={!canAnswer} onPress={() => answer('counteroffer')} />
      <SettingsAction placement="page" title="代替案を送らず戻る" disabled={disabled} onPress={() => edit({ offerOpen: false })} />
    </View> : <SettingsAction placement="page" title="代替日時を提案…" disabled={disabled} onPress={() => edit({ offerOpen: true })} /> : null}
    {request.proposal.proposedMode === 'fixed' ? <Text style={styles.caption}>{calendarStatus ? `${label(calendarStatus.target)}の本人用Calendar：${calendarStatus.kind === 'clear' ? '取得済み情報の範囲では重複なし' : calendarStatus.kind === 'conflict' ? '予定と重複しています' : '最新の予定を確認できません'}`
      : '本人用Calendarは未確認です。他のメンバーの予定内容は表示しません。'}</Text> : null}
    {confirmation ? <V2DateConfirmation kind={confirmation.kind} disabled={!canAnswer} confirmLabel="確認して回答を保存"
      onConfirm={() => { if (confirmation.revision !== inputRevision.current) { resetConfirmation(); return; }
        confirmed.current[confirmation.kind] = true; setConfirmation(null); return answer(confirmation.decision, confirmation.referenceDecisionId); }}
      onCancel={resetConfirmation} /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </Card>;
}
