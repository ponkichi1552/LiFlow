import { useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { Card, Page, palette, typography } from '@/components/planner-ui';
import { SettingsAction, SettingsGroup, SettingsStatus } from '@/components/settings-controls';
import { SettingsHeader } from '@/components/settings-header';
import { SettingsList, SettingsRow } from '@/features/settings/settings-navigation';
import { GroupAdminReview } from '@/features/sharing/group-admin-review';
import { GroupJoinWaiting, GroupSettingsStatusRows, GroupSignInActions, GroupSyncStatus } from '@/features/sharing/group-settings-status';
import { GroupCreationForm } from '@/features/sharing/group-creation-form';
import { groupSettingsTitles, type GroupSettingsSection } from '@/features/sharing/group-settings-sections';
import { V2AssignmentRequests } from '@/features/sharing/v2-ui/assignment-requests';
import { V2DateRequests } from '@/features/sharing/v2-ui/date-requests';
import type { V2GroupController, V2GroupScreenModel } from '@/features/sharing/v2/controller';
import type { DateTarget } from '@/features/sharing/v2/model';
import { addDays } from '@/domain/scheduling/local-date';
import { homeReviewData, homeReviewGroup } from './home-review-data';

export const groupReviewScenarios = [
  { id: 'group-sign-in', label: '共有グループにログインしていない' },
  { id: 'group-restoring', label: '以前のグループを復元中' },
  { id: 'group-create', label: 'ログイン後・グループを新規作成' },
  { id: 'group-member', label: '一般メンバー・自分の申請に回答' },
  { id: 'group-secondary', label: '管理者の別端末・要確認' },
  { id: 'group-owner', label: '管理端末・メンバーと招待' },
  { id: 'group-waiting', label: 'グループへの参加承認待ち' },
  { id: 'group-requests-loading', label: '変更の申請を取得中' },
  { id: 'group-requests-empty', label: '変更の申請なし' },
  { id: 'group-requests-error', label: '変更の申請を読み込めない' },
  { id: 'group-unsent', label: 'オフラインで保存した変更が未送信' },
  { id: 'group-held', label: '復元後に確認待ちの変更がある' },
  { id: 'group-sync-error', label: '同期失敗・もう一度同期' },
] as const;

type Actions = Pick<V2GroupController['actions'], 'decide' | 'answerAssignment' | 'approveSubstitution'>;
const runLocal = async (work: () => Promise<unknown>) => { await work(); };

function GroupEntryReview({ scenario, onExit }: { scenario: string; onExit(): void }) {
  const [state, setState] = useState(scenario);
  const [name, setName] = useState(homeReviewGroup);
  if (state === 'managed') return <GroupSession scenario="group-owner" groupName={name} onExit={() => setState('ready')} />;
  const header = <SettingsHeader title="共有グループ" onBack={onExit} backAccessibilityLabel="UI確認用データ一覧へ戻る" />;
  return <Page header={header}>
    {state === 'group-sign-in' || state === 'group-create' ? <SettingsStatus>個人の家事・予定は共有されません。</SettingsStatus> : null}
    {state === 'group-sign-in' ? <GroupSignInActions busy={false} onGoogle={() => setState('group-create')}
      onApple={() => setState('group-create')} /> : null}
    {state === 'group-restoring' ? <>
      <SettingsStatus>グループを復元中です。以前の端末が接続すると自動で参加します。</SettingsStatus>
      <SettingsAction title="確認用データの復元を完了" onPress={() => setState('ready')} />
    </> : null}
    {state === 'group-create' ? <GroupCreationForm protocol={2} busy={false} onCreate={async value => { setName(value); setState('ready'); return true; }} /> : null}
    {state === 'ready' ? <Card><Text style={{ ...typography.subheading, color: palette.ink }}>{name}</Text><SettingsStatus>参加中</SettingsStatus>
      <SettingsAction title="グループを管理" onPress={() => setState('managed')} />
    </Card> : null}
  </Page>;
}

function groupReviewModel(scenario: string): V2GroupScreenModel {
  const { model } = homeReviewData('conditions');
  const admin = scenario === 'group-secondary' || scenario === 'group-owner';
  if (admin) model.viewerUserId = model.adminUserId;
  // The review scenario only contains pending substitutes, so its decision buttons update the same visible list.
  model.plan.occurrences = model.plan.occurrences.filter(round => round.subjects.every(subject =>
    !['conflict', 'review'].includes(subject.formalDate.kind)) && round.claimState !== 'provisional' && !round.assignmentConflictIds.length);
  if (scenario === 'group-requests-empty') return model;
  const round = model.plan.occurrences[0];
  const { id: occurrenceId, choreId, anchorDate } = round;
  const timeZone = model.plan.timeZone;
  const original: DateTarget = { precision: 'date', date: anchorDate };
  const proposed: DateTarget = { precision: 'date', date: addDays(anchorDate, 1) };
  const deadline = { kind: 'open' as const, referenceAt: Date.parse(`${anchorDate}T12:00:00+09:00`),
    requestedAt: Date.parse('2026-12-28T09:00:00+09:00'), expiresAt: Date.parse('2026-12-31T09:00:00+09:00'), graceHours: 24 };
  const requestId = 'review-date-request';
  const requesterUserId = model.plan.members.find(member => member.userId !== model.viewerUserId && member.userId !== model.adminUserId)?.userId ?? model.adminUserId;
  model.requests = [{ requestId, kind: 'awaiting', original, originalTimeZone: timeZone, originalWasConflicted: false,
    originalRuleIds: [], formal: original, formalOptions: null, deadline, confirmation: null, confirmedAt: null, counteroffers: [], conflictIds: [], decisions: [],
    timeZone, proposedTimeZone: timeZone,
    audience: { automatic: false, administratorVote: true, approvingMemberIds: [model.viewerUserId], counterofferRecipientIds: [requesterUserId] },
    proposal: { requesterUserId, choreId, anchorDate, occurrenceId, subjectUserId: round.subjects[0]?.subjectUserId ?? null,
      originalDesignationId: null, original, proposed, proposedMode: 'day', proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false },
      selector: { scope: 'once', occurrenceId, anchorDate }, extensionScope: 'once' } }];
  model.requestReviews = [{ requestId, revision: 'initial', answers: [], pendingAnswer: false, canVote: true, canCounteroffer: admin, acceptableCounterofferIds: [] }];
  const assignmentId = 'review-assignment-request';
  model.assignmentRequests = [{ requestId: assignmentId, kind: 'awaiting', cancelled: false, confirmation: null, decisions: [], conflictIds: [], deadline,
    proposal: { requesterUserId: admin ? requesterUserId : model.viewerUserId, choreId, occurrenceId, anchorDate, reference: original,
      originalMemberIds: [requesterUserId], originalAssignmentIds: [], originalClaimOperationIds: [], memberIds: [model.viewerUserId],
      scope: 'once', fixed: false, ruleVersion: round.ruleVersion, timeZone } }];
  model.assignmentReviews = [{ requestId: assignmentId, revision: 'initial', answers: [], pendingAnswer: false, canVote: admin, canResolve: false }];
  return model;
}

export function GroupReview({ scenario, onExit }: { scenario: string; onExit(): void }) {
  if (['group-sign-in', 'group-restoring', 'group-create'].includes(scenario)) return <GroupEntryReview scenario={scenario} onExit={onExit} />;
  return <GroupSession scenario={scenario} onExit={onExit} />;
}

function GroupSession({ scenario, onExit, groupName = homeReviewGroup }: { scenario: string; onExit(): void; groupName?: string }) {
  const [model, setModel] = useState(() => groupReviewModel(scenario));
  const [section, setSection] = useState<GroupSettingsSection | undefined>(() => scenario.startsWith('group-requests') ? 'requests' : undefined);
  const [waiting, setWaiting] = useState(scenario === 'group-waiting');
  const [requestRead, setRequestRead] = useState(scenario === 'group-requests-loading' ? 'loading' : scenario === 'group-requests-error' ? 'error' : 'loaded');
  const [syncFailed, setSyncFailed] = useState(scenario === 'group-sync-error');
  const [pending, setPending] = useState(['group-unsent', 'group-sync-error'].includes(scenario) ? 2 : 0);
  const [held, setHeld] = useState(scenario === 'group-held' ? 1 : 0);
  const [synced, setSynced] = useState(false);
  const [invite, setInvite] = useState(false);
  const ownerDevice = scenario === 'group-owner';
  const admin = model.viewerUserId === model.adminUserId;
  const baseExample = scenario.startsWith('group-requests');
  const actions: Actions = {
    async decide(id, decision, target) {
      setModel(before => ({ ...before,
        requests: before.requests.map(request => request.requestId !== id ? request : { ...request,
          kind: decision === 'counteroffer' ? 'counteroffered' : decision === 'reject' ? 'rejected' : 'approved',
          formal: decision === 'approve' ? request.proposal.proposed : request.formal,
          counteroffers: target && request.deadline.kind === 'open' ? [{ operationId: 'review-offer', target,
            options: request.proposal.proposedOptions, expiresAt: request.deadline.expiresAt }] : [] }),
        requestReviews: before.requestReviews.map(review => review.requestId === id ? { ...review, revision: 'answered', canVote: false, canCounteroffer: false } : review),
      }));
      return [];
    },
    async answerAssignment(id, decision) {
      setModel(before => ({ ...before,
        assignmentRequests: before.assignmentRequests.map(request => request.requestId === id ? { ...request, kind: decision === 'approve' ? 'approved' : 'rejected' } : request),
        assignmentReviews: before.assignmentReviews.map(review => review.requestId === id ? { ...review, revision: 'answered', canVote: false } : review),
      }));
      return [];
    },
    async approveSubstitution(id) {
      setModel(before => ({ ...before, plan: { ...before.plan, history: before.plan.history.filter(record => record.operationId !== id) } }));
      return [];
    },
  };

  if (scenario === 'group-waiting' && !waiting) return <GroupEntryReview scenario="group-create" onExit={onExit} />;
  const header = <SettingsHeader title={section ? groupSettingsTitles[section] : groupName} onBack={section && !baseExample ? () => setSection(undefined) : onExit}
    backAccessibilityLabel={section && !baseExample ? 'グループ設定に戻る' : 'UI確認用データ一覧へ戻る'} />;
  return <Page header={header}>
    {waiting ? <><GroupJoinWaiting code="218 604" />
      <SettingsAction title="参加申請を取り消す" intent="destructive" onPress={() => setWaiting(false)} />
    </> : null}
    {!section ? <SettingsList>
      {!waiting ? <SettingsRow title={groupSettingsTitles.members} summary={`${model.plan.members.length}人`} onPress={() => setSection('members')} /> : null}
      <GroupSettingsStatusRows active={!waiting} admin={admin} busy={false} pending={pending} held={held} syncFailed={syncFailed} onOpen={setSection} />
    </SettingsList> : null}
    {section === 'members' ? <><SettingsGroup title="メンバー">{model.plan.members.map(member => <View key={member.userId} style={{ gap: 3 }}>
      <Text style={{ ...typography.body, color: palette.ink }}>{member.displayName}{member.userId === model.viewerUserId ? '（自分）' : ''}</Text>
      {member.userId === model.adminUserId ? <SettingsStatus>管理者</SettingsStatus> : null}
    </View>)}</SettingsGroup>
      {ownerDevice ? <SettingsGroup title="招待リンク">
        <SettingsAction title="メンバーを招待" accessibilityLabel="招待リンクとQRを作る" onPress={() => setInvite(true)} />
        {invite ? <Card><SettingsStatus>12月31日 20:00まで</SettingsStatus>
          <SettingsAction title="取り消す" intent="destructive" onPress={() => Alert.alert('招待を取り消しますか？', 'このリンクから新しい参加申請はできなくなります。', [
            { text: 'キャンセル', style: 'cancel' }, { text: '取り消す', style: 'destructive', onPress: () => setInvite(false) },
          ])} />
        </Card> : null}
      </SettingsGroup> : null}
    </> : null}
    {section === 'requests' ? <>
      {requestRead === 'loading' ? <><ActivityIndicator accessibilityLabel="変更の申請を確認中" color={palette.accent} />
        <SettingsAction title="確認用データの読み込みを完了" onPress={() => setRequestRead('loaded')} />
      </> : requestRead === 'error' ? <><Text accessibilityRole="alert" style={{ color: palette.warning }}>申請を読み込めませんでした。</Text>
        <SettingsAction title="申請を再読込" placement="page" onPress={() => setRequestRead('loaded')} />
      </> : <>
        <SettingsGroup title="日時変更"><V2DateRequests embedded model={model} actions={actions} busy={false} run={runLocal} /></SettingsGroup>
        <SettingsGroup title="担当変更"><V2AssignmentRequests embedded model={model} actions={actions} busy={false} run={runLocal} /></SettingsGroup>
      </>}
    </> : null}
    {section === 'review' ? <GroupAdminReview model={model} actions={actions} busy={false} run={runLocal} /> : null}
    {section === 'sync' ? <>
      {syncFailed ? <Text accessibilityRole="alert" style={{ color: palette.warning }}>グループと同期できませんでした。</Text> : null}
      <GroupSyncStatus pending={pending} held={held} lastSyncAt={synced ? Date.parse('2026-12-30T03:05:00Z') : undefined} disabled={false}
        onSync={() => { setSyncFailed(false); setPending(0); setSynced(true); }} />
      {held ? <SettingsAction title="変更を確認" onPress={() => Alert.alert('確認待ちの変更', '元の変更をこの端末で確認しました。', [
        { text: '閉じる', style: 'cancel' }, { text: '確認済みにする', onPress: () => setHeld(0) },
      ])} /> : null}
    </> : null}
  </Page>;
}
