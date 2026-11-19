import { v2MemberLabels } from './member-labels';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, Card, SectionHeading } from '../../../components/planner-ui';
import { canonicalJson } from '../operations';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence } from '../v2/common-plan';
import type { V2RoundReference } from '../v2/actions';
import { V2Choices, V2Flag, v2FormStyles as styles } from './form-controls';

type Target = Awaited<ReturnType<V2GroupController['actions']['readAssignmentTarget']>>;
type Validity = 'once' | 'fromThis' | 'fromNext';
type Props = { model: V2GroupScreenModel; round: V2PlannedOccurrence; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void> };
const sourceRevision = (model: V2GroupScreenModel, round: V2PlannedOccurrence) => canonicalJson({
  configurations: model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId).sort() ?? [],
  assignments: round.assignmentOperationIds, conflicts: round.assignmentConflictIds, claims: round.claimOperationIds,
  mapping: model.plan.issues.filter((issue) => issue.choreId === round.choreId && issue.kind === 'oneOffAssignmentMappingNeedsReview').flatMap((issue) => issue.operationIds).sort(),
  members: model.plan.members.filter((member) => member.active).map((member) => member.userId).sort(),
  admin: model.adminUserId, zone: model.plan.timeZone,
});

/** Assignment changes are explicit commands. Selecting people never autosaves or rewrites work history. */
export function V2AssignmentForm(props: Props) {
  return <AssignmentEditor key={props.round.id} {...props} />;
}
function AssignmentEditor({ model, round, actions, busy, run }: Props) {
  const [source] = useState(() => ({ revision: sourceRevision(model, round), ref: { choreId: round.choreId, anchorDate: round.anchorDate,
    ruleVersion: round.ruleVersion, subjectUserId: null,
    expectedConfigurationIds: model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId),
    expectedTimeZone: model.plan.timeZone } satisfies V2RoundReference,
    target: { occurrenceId: round.id, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, assigneeIds: round.assigneeIds,
      assignmentIds: round.assignmentOperationIds, conflictIds: round.assignmentConflictIds, mappingReviewIds: round.assignmentMappingReviewIds,
      claimIds: round.claimOperationIds, claimantUserIds: round.claimantUserIds, fixed: round.assignmentFixed, active: round.activeInPeriod,
      completion: round.configuration.policy.completion } satisfies Target }));
  const [target, setTarget] = useState<Target | null>(source.target);
  const [draft, setDraft] = useState({ validity: 'once' as Validity, memberIds: [...round.assigneeIds], fixed: round.assignmentFixed,
    membersEdited: false, fixedEdited: false, reviewed: false, mappingIds: [] as string[] });
  const input = useRef(draft); const alive = useRef(true); const inFlight = useRef(false);
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null); const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stale = source.revision !== sourceRevision(model, round);
  const admin = model.viewerUserId === model.adminUserId;
  const active = model.plan.members.some((member) => member.active && member.userId === model.viewerUserId);
  const disabled = busy || saving || loading || stale || !active || !model.plan.initialized || Boolean(saved);
  const nameOf = v2MemberLabels(model.plan.members);
  const edit = (patch: Partial<typeof draft>) => { if (inFlight.current) return; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); };
  const selectValidity = async (validity: Validity) => {
    if (disabled || inFlight.current) return;
    edit({ validity, reviewed: false, mappingIds: [] }); setTarget(null);
    inFlight.current = true; setLoading(true);
    try { await run(async () => {
      try {
        const value = await actions.readAssignmentTarget(source.ref, validity === 'fromNext' ? 'next' : 'this');
        if (!alive.current) return;
        const members = input.current.membersEdited ? input.current.memberIds : [...value.assigneeIds];
        input.current = { ...input.current, memberIds: members,
          fixed: members.length > 0 && (input.current.fixedEdited ? input.current.fixed : value.fixed) };
        setDraft(input.current); setTarget(value);
      }
      catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '対象の家事回を確認できません。'); }
    }); } finally { inFlight.current = false; if (alive.current) setLoading(false); }
  };
  const orphanIds = [...new Set(model.plan.issues.filter((issue) => issue.choreId === round.choreId && issue.kind === 'oneOffAssignmentMappingNeedsReview').flatMap((issue) => issue.operationIds))];
  const mappingIds = [...new Set([...(target?.mappingReviewIds ?? []), ...draft.mappingIds])];
  const mapping = mappingIds.map((id) => model.assignmentRules.find((fact) => fact.operationId === id));
  const needsReview = Boolean(target?.conflictIds.length || target && target.claimantUserIds.length > 1 || mappingIds.length);
  const canSubmit = !disabled && target !== null && target.active && (admin || target.assigneeIds.includes(model.viewerUserId));
  const changesAssignment = (current: typeof draft) => Boolean(target && (current.fixed !== target.fixed ||
    current.memberIds.length !== target.assigneeIds.length || current.memberIds.some(id => !target.assigneeIds.includes(id))
    || current.validity !== 'once' && (current.membersEdited || current.fixedEdited)));
  const submit = async () => {
    if (!canSubmit || !target || inFlight.current) return;
    const current = input.current; const scope = current.validity === 'once' ? 'once' : 'from';
    const chosenMappings = [...new Set([...target.mappingReviewIds, ...current.mappingIds])].map((id) => model.assignmentRules.find((fact) => fact.operationId === id));
    if (!changesAssignment(current) && !target.conflictIds.length && target.claimantUserIds.length <= 1 && !chosenMappings.length) return;
    if ((target.conflictIds.length || target.claimantUserIds.length > 1 || chosenMappings.length) && !current.reviewed) {
      setError('元の担当・競合と実施履歴を確認してください。'); return;
    }
    if (chosenMappings.some((fact) => !fact)) { setError('以前の担当指定を確認できません。同期して現在の家事回を開き直してください。'); return; }
    if (target.conflictIds.length && scope === 'from' && model.assignmentRules.some((fact) => target.conflictIds.includes(fact.operationId) && fact.payload.scope === 'once')) {
      setError('今回だけの担当競合は、今回だけを選んで解決してください。'); return;
    }
    const editGuard = { expectedTargetOccurrenceId: target.occurrenceId, expectedAssignmentIds: target.assignmentIds,
      expectedConflictIds: target.conflictIds, expectedClaimIds: target.claimIds };
    const fixed = current.memberIds.length > 0 && current.fixed;
    inFlight.current = true; setSaving(true); setError(null);
    try { await run(async () => {
      try {
        const targetRef = { ...source.ref, anchorDate: target.anchorDate, ruleVersion: target.ruleVersion };
        if (!admin) await actions.requestAssignment(source.ref, { memberIds: current.memberIds, start: current.validity === 'fromNext' ? 'next' : 'this', scope, fixed, ...editGuard });
        else if (chosenMappings.length) {
          const changes = await actions.remapAssignments([...new Set(chosenMappings.map((fact) => fact!.sourceRequestId ?? fact!.operationId))], targetRef, current.memberIds, scope, fixed, editGuard);
          if (!changes.length) throw new Error('以前の担当指定が変更されています。入力を保持したまま、最新の家事回を確認してください。');
        }
        else if (target.conflictIds.length) await actions.resolveAssignment(targetRef, current.memberIds, scope, fixed, editGuard);
        else if (target.claimantUserIds.length > 1 && current.validity === 'once') await actions.resolveClaims(targetRef, current.memberIds, fixed, target.claimIds);
        else await actions.assign(source.ref, current.memberIds, current.validity === 'fromNext' ? 'next' : 'this', fixed, { ...editGuard, scope });
        if (alive.current) setSaved(admin ? '担当変更を端末に保存しました。実施済みの履歴・実施者・本来担当は保持されています。'
          : '担当変更の申請を端末に保存しました。サーバー受付と管理者の承認までは元の担当を維持します。');
      } catch (cause) { if (alive.current) setError(cause instanceof Error && 'code' in cause && cause.code === 'sharing/v2-authority-denied'
        ? '担当・メンバーまたは権限が変わっています。現在の家事回を確認してください。' : cause instanceof Error ? cause.message : '担当変更を保存できませんでした。'); }
    }); } finally { inFlight.current = false; if (alive.current) setSaving(false); }
  };
  if (saved) return <Card><Text accessibilityLiveRegion="polite" style={styles.body}>{saved}</Text></Card>;
  return <Card><SectionHeading title={admin ? '担当を変更する' : '担当変更を申請する'} />
    <Text style={styles.caption}>実施履歴は変更しません。選択だけでは保存されません。</Text>
    {stale ? <Text accessibilityRole="alert" style={styles.error}>担当・周期・メンバーまたは権限が変わりました。入力は保持しています。現在の家事回を開き直してください。</Text> : null}
    <V2Choices label="担当変更の適用範囲" value={draft.validity} disabled={disabled} onChange={selectValidity}
      choices={[{ value: 'once', label: '今回だけ' }, { value: 'fromThis', label: '今回から' }, { value: 'fromNext', label: '次回から' }]} />
    {loading ? <Text style={styles.caption}>実際の次回と担当を確認しています…</Text> : target ? <View style={{ gap: 6 }}>
      <Text style={styles.body}>適用する基準日：{target.anchorDate}{draft.validity === 'once' ? '（この回だけ）' : 'から'}</Text>
      <Text style={styles.caption}>現在の担当：{target.assigneeIds.map(nameOf).join('・') || (target.completion === 'one' ? '担当未確定' : '対象者なし')}</Text>
      {!target.active ? <Text style={styles.error}>この家事回は無効です。共通設定を確認してください。</Text> : null}
    </View> : <AppButton title="対象の家事回を再確認" variant="secondary" disabled={disabled} onPress={() => selectValidity(input.current.validity)} />}
    <SectionHeading title="変更後の担当" />
    {model.plan.members.filter((member) => member.active).map((member) => <V2Flag key={member.userId} label={`担当：${nameOf(member.userId)}`} value={draft.memberIds.includes(member.userId)} disabled={disabled}
      onChange={(selected) => {
        const memberIds = [...new Set(selected ? [...input.current.memberIds, member.userId] : input.current.memberIds.filter((uid) => uid !== member.userId))].sort();
        edit({ memberIds, membersEdited: true, ...(memberIds.length ? {} : { fixed: false }) }); }} />)}
    {!draft.memberIds.length ? <Text style={styles.caption}>{target?.completion === 'perMember' ? 'この回の実施対象者をなしにします。過去の実施履歴は残ります。' : '担当未確定に戻し、メンバーが引き受けられるようにします。'}</Text> : null}
    <V2Flag label="管理者による固定担当にする" value={draft.fixed} disabled={disabled || !draft.memberIds.length} onChange={(fixed) => edit({ fixed, fixedEdited: true })} />
    {!admin ? <Text style={styles.caption}>固定担当の変更・解除は申請として保存し、管理者の承認までは正式な担当を変えません。</Text> : null}
    {admin && orphanIds.length ? <View style={{ gap: 8 }}><SectionHeading title="対応付けが必要な以前の担当指定" />
      <Text style={styles.caption}>この家事回へ移す元の指定だけを選んでください。選ばなかった指定は保持します。</Text>
      {orphanIds.map((id) => { const fact = model.assignmentRules.find((entry) => entry.operationId === id); return fact ? <V2Flag key={id}
        label={`${fact.payload.fromAnchorDate}の担当指定をこの回へ対応付ける`} value={draft.mappingIds.includes(id)} disabled={disabled}
        onChange={(selected) => edit({ mappingIds: selected ? [...new Set([...input.current.mappingIds, id])] : input.current.mappingIds.filter((value) => value !== id), reviewed: false })} /> : <Text key={id} style={styles.error}>以前の担当指定を取得できません。同期してください。</Text>; })}
    </View> : null}
    {needsReview ? <View style={{ gap: 8 }}><Text style={styles.error}>担当が競合または暫定状態です。実際に作業した人の履歴を残したまま、正式な担当を決めます。</Text>
      {mapping.map((fact, index) => <Text key={mappingIds[index]} style={styles.caption}>以前の担当指定：{fact ? `${fact.payload.fromAnchorDate}${fact.payload.scope === 'from' ? 'からの適用期間全体を解除して対応付けます' : 'の回を解除して対応付けます'}` : '元の指定を取得できません'}</Text>)}
      <V2Flag label="元の担当・競合と履歴への影響を確認した" value={draft.reviewed} disabled={disabled} onChange={(reviewed) => edit({ reviewed })} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <AppButton title={admin ? '担当変更を保存' : '担当変更を申請'} disabled={!canSubmit || !changesAssignment(draft) && !needsReview} onPress={submit} />
  </Card>;
}
