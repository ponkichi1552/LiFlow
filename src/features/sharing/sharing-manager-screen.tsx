import { GroupManagementLinks } from './group-management-links';
import { V2_SCHEDULER_VERSION } from '@/features/sharing/v2/payload-schema';
import { FormTextInput as TextInput } from '../../components/form-text-input';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Share, StyleSheet, Text, View } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import { AccordionSection } from '@/components/accordion-section';
import { ChoreSettingsSources } from '@/features/settings/chore-settings-sources';
import { useWorkspace } from '@/hooks/use-workspace';
import { enableSharingSession, createV2SharingWorkspace, openSharedWorkspace, requestSharingWorkspace, sharingFailureMessage, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import { GroupCreationForm } from '@/features/sharing/group-creation-form';
import { sharingCreationProtocol } from '@/features/sharing/rollout';
import type { SharedWorkspace } from '@/platform/sharing/workspaces';
import type { SharedWorkspaceOverview } from '@/platform/sharing/workspace-types';
import { isSharingConfigured } from '@/platform/sharing/firebase-services';
import { isSharingAppleSignInAvailable, signInSharingWithApple, signInSharingWithGoogle, signOutSharing } from '@/platform/sharing/auth';
import { sharingInvitationQr } from '@/features/sharing/invitation-qr';
import { sharedJoinVerificationCode } from '@/features/sharing/invitations';
import type { SharedJoinRequest, SignedSharedInvitation } from '@/features/sharing/invitations';
import { LegacyMigrationPanel } from '@/features/sharing/v2/legacy-migration-panel';
import { V2RecoveryPanel } from '@/features/sharing/v2/recovery-panel';

export default function SharingScreen({ detailOnly = false }: { detailOnly?: boolean }) {
  const context = useWorkspace(); const params = useLocalSearchParams<{ groupId?: string }>();
  const [link, setLink] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const selectedId = typeof params.groupId === 'string' ? params.groupId : context.group?.groupId ?? null;
  const [selected, setSelected] = useState<SharedWorkspace | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false); const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); const alive = useRef(true); const [message, setMessage] = useState<string | null>(null);
  const currentUserId = useRef(context.userId);
  useLayoutEffect(() => { currentUserId.current = context.userId; }, [context.userId]);
  const creationProtocol = sharingCreationProtocol();
  const selectedRecord = context.group?.groupId === selectedId ? context.group : null;
  const canOpenSelected = detailOnly && Boolean(selectedRecord);
  const selectedRevision = JSON.stringify([selectedRecord?.status, selectedRecord?.localGeneration, selectedRecord?.rosterArchive?.at(-1)?.body.revision]);
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return false; inFlight.current = true; setBusy(true); setMessage(null);
    let workFinished = false;
    try { await work(); workFinished = true; await context.refreshSharing(); return true; }
    catch (cause) { if (alive.current) setMessage(userMessage(cause)); return workFinished; }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    if (isSharingConfigured()) void enableSharingSession().then(context.refreshSharing).catch(() => undefined);
    void isSharingAppleSignInAvailable().then(setAppleAvailable).catch(() => undefined);
    return () => { alive.current = false; };
  }, [context.refreshSharing]);
  useEffect(() => {
    let current = true;
    if (canOpenSelected && selectedId && context.userId) void openSharedWorkspace({ userId: context.userId, groupId: selectedId })
      .then((workspace) => { if (current) setSelected(workspace); }).catch((cause) => { if (current) setMessage(userMessage(cause)); });
    return () => { current = false; };
  }, [canOpenSelected, context.userId, selectedId, selectedRevision]);
  if (detailOnly) return <Page header={<BackButton onPress={() => router.canGoBack() ? router.back() : router.replace('/sharing')} />}>

    {message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null}
    {!context.userId ? <Card><Text style={styles.body}>グループを管理するアカウントへログインしてください。</Text><AppButton title="ログイン" onPress={() => router.replace('/sharing')} /></Card>
      : selected && selected.groupId === selectedId && selected.userId === context.userId ? <GroupDetail key={`${selected.userId}:${selected.groupId}:${selected.identity.deviceId}:${selected.protocol}`} workspace={selected} run={run} busy={busy} />
      : !selectedRecord ? <Text style={styles.body}>現在の所属グループを確認してください。</Text> : message ? null : <ActivityIndicator color={palette.accent} />}
  </Page>;
  return <Page header={<BackButton onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />}>

    <ScreenHeading title="共有グループ" description="家族や同居人と、家事の予定や完了を共有できます。" />
    <Text style={styles.caption}>個人の家事・予定も同じ画面で使えます。個人データは共有されません。</Text>
    {!isSharingConfigured() ? <Card><Text style={styles.error}>このビルドは共有先が未設定です。</Text></Card> : !context.userId ? <Card>
      <SectionHeading title="共有用アカウント" />
      <Text style={styles.body}>個人利用ではログインは不要です。グループへの参加時に使用するアカウントを選んでください。</Text>
      <AppButton title="Googleで続ける" disabled={busy} onPress={() => void run(async () => { await signInSharingWithGoogle(); })} />
      {appleAvailable ? <AppButton title="Appleで続ける" variant="secondary" disabled={busy} onPress={() => void run(async () => { await signInSharingWithApple(); })} /> : null}
    </Card> : <>
      {context.group ? <Card>
        <Text style={styles.label}>{context.group.displayName}</Text>
        <Text style={styles.caption}>{context.group.status === 'joining' ? '所有者の承認待ち' : context.group.status === 'creating' ? '端末に保存済み · 共有先への作成待ち' : '参加中'}</Text>
        <AppButton title="グループを管理" compact variant="secondary" disabled={busy} onPress={() => router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: context.group!.groupId } })} />
      </Card> : <>
        <Card><Text style={styles.body}>参加中のグループはありません。</Text></Card>
      <AccordionSection title="グループを作る" expanded={expanded === 'create'} onToggle={() => setExpanded(expanded === 'create' ? null : 'create')}>
        <GroupCreationForm key={context.userId} protocol={creationProtocol} busy={busy} onCreate={(name, kind) => run(async () => {
          const owner = context.userId;
          const workspace = await createV2SharingWorkspace(name, kind!);
          if (alive.current && currentUserId.current === owner) { setExpanded(null); router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: workspace.groupId } }); }
        })} />
      </AccordionSection>
      <AccordionSection title="招待から参加する" expanded={expanded === 'join'} onToggle={() => setExpanded(expanded === 'join' ? null : 'join')}>
        <TextInput style={[styles.input, styles.multiline]} multiline value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false}
          placeholder="LiFlowの招待リンクを貼り付け" accessibilityLabel="招待リンク" editable={!busy} />
        <Text style={styles.caption}>申請後、所有者の端末で承認されると参加できます。</Text>
        <AppButton title="参加を申請" disabled={busy || !link.trim()} onPress={() => void run(async () => {
          const owner = context.userId; const workspace = await requestSharingWorkspace(link);
          if (alive.current && currentUserId.current === owner) { setLink(''); setExpanded(null); router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: workspace.groupId } }); }
        })} />
      </AccordionSection>
      </>}
      <AppButton title="共有用アカウントからログアウト" variant="quiet" disabled={busy} onPress={() => void run(async () => { if (context.active) await context.active.drain(); await signOutSharing(); await context.refreshSharing(); })} />
    </>}
    {busy ? <ActivityIndicator color={palette.accent} /> : null}
    {message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null}
    <AccordionSection title="共有について" expanded={expanded === 'help'} onToggle={() => setExpanded(expanded === 'help' ? null : 'help')}>
      <Text style={styles.body}>同時に参加できるグループは一つです。変更するときは退出してから次のグループへ参加します。</Text>
      <Text style={styles.body}>家事・履歴・ゴミ収集日・確認済みの家電情報を端末で暗号化して同期します。共有先へ平文の家事内容や秘密鍵を送信しません。</Text>
      <Text style={styles.body}>確認済みの家電の説明と添付PDFも暗号化して共有します。Google Tasksの紐付け、個人のCalendar予定、通知設定、Widget、APIキーは共有しません。</Text>
      <Text style={styles.body}>通信できない間も編集できます。送信待ちの操作は保持し、接続後に再送します。同じ設定を同時に編集したときは、内容を確認して選びます。</Text>
      <Text style={styles.body}>バックグラウンドの実行時刻はOSが決めるため、即時の反映を保証しません。必要なときは「今すぐ同期」を使ってください。</Text>
      <Text style={styles.body}>端末の鍵を失ったときは、参加中の別の端末から新しい端末を招待・承認してください。すべての端末の鍵を失うと、保管先の暗号文だけから内容を復元できません。</Text>
      <Text style={styles.body}>退出・除名後の再参加には新しい招待と承認が必要です。前回の未送信変更はこの端末に保管し、自動で再送・合併しません。</Text>
    </AccordionSection>
  </Page>;
}

export function GroupDetail({ workspace, run, busy }: { workspace: SharedWorkspace; run: (work: () => Promise<void>) => Promise<boolean>; busy: boolean }) {
  const context = useWorkspace();
  const [detail, setDetail] = useState<{ record: Awaited<ReturnType<SharedWorkspace['record']>>; pending: number;
    snapshot: SharedWorkspaceOverview | null; openError: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [requests, setRequests] = useState<{ invitation: SignedSharedInvitation; request: SharedJoinRequest }[]>([]);
  const [requestRead, setRequestRead] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestAttempt, setRequestAttempt] = useState(0);
  const manager = workspace.manager;
  const [invite, setInvite] = useState<Awaited<ReturnType<NonNullable<SharedWorkspace['manager']>['createInvitation']>> | null>(null);
  const [failedQr, setFailedQr] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [choreSettingsOpen, setChoreSettingsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false); const [syncOpen, setSyncOpen] = useState(false); const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const currentWorkspace = useRef<SharedWorkspace | null>(workspace);
  useEffect(() => { currentWorkspace.current = workspace; return () => { currentWorkspace.current = null; }; }, [workspace]);
  const loadState = useRef<{ workspace: SharedWorkspace; pending: Promise<NonNullable<typeof detail>> | null; again: boolean }>({ workspace, pending: null, again: false });
  const load = useCallback((): Promise<NonNullable<typeof detail>> => {
    const state = loadState.current.workspace === workspace ? loadState.current : (loadState.current = { workspace, pending: null, again: false });
    if (state.pending) { state.again = true; return state.pending; }
    const read = async () => {
      let next: NonNullable<typeof detail>;
      do {
        state.again = false;
        const record = await workspace.record(); const checkpoint = await workspace.checkpoint();
        let snapshot: SharedWorkspaceOverview | null = null; let openError: string | null = null;
        try { if (['active', 'creating'].includes(record.status)) snapshot = await workspace.readOverview(); }
        catch (cause) { openError = userMessage(cause); }
        next = { record, snapshot, pending: checkpoint.pendingCount, openError };
        if (state.again && currentWorkspace.current === workspace) setDetail(next);
      } while (state.again && currentWorkspace.current === workspace);
      return next;
    };
    const task = read(); state.pending = task;
    void task.finally(() => { if (state.pending === task) state.pending = null; }).catch(() => undefined);
    return task;
  }, [workspace]);
  const refresh = useCallback(async () => { const next = await load(); if (currentWorkspace.current === workspace) setDetail(next); }, [load, workspace]);
  useEffect(() => {
    let current = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => { void load().then((next) => { if (current) { setDetail(next); setLoadError(null); } })
      .catch((cause) => { if (current) setLoadError(userMessage(cause)); }); };
    read(); const unsubscribe = subscribeSharingChanges((scope) => { if (scope?.userId === workspace.userId && scope.groupId === workspace.groupId) { clearTimeout(timer); timer = setTimeout(read, 80); } });
    return () => { current = false; clearTimeout(timer); unsubscribe(); };
  }, [load, workspace, readAttempt]);
  useEffect(() => { if (!invite) return; const timer = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(timer); }, [invite]);
  const preparedQr = useMemo(() => {
    try { return invite ? sharingInvitationQr(invite.url) : null; } catch { return null; }
  }, [invite]);
  const qr = invite && invite.invitation.body.expiresAt > clock ? preparedQr : null;
  const roster = workspace.roster(); const isOwner = roster?.body.ownerDeviceId === workspace.identity.deviceId;
  const readRequests = useCallback(async () => {
    if (!isOwner) return [];
    const invitations = (await workspace.cloud.listInvitations(workspace.groupId)).filter(entry => entry.status === 'open' && entry.invitation.body.expiresAt > Date.now());
    const next: { invitation: SignedSharedInvitation; request: SharedJoinRequest }[] = [];
    for (let offset = 0; offset < invitations.length; offset += 4) {
      const pages = await Promise.all(invitations.slice(offset, offset + 4).map(async item => {
        const result = await workspace.cloud.listJoinRequests(item.invitation);
        return result.requests.map(request => ({ invitation: item.invitation, request }));
      }));
      next.push(...pages.flat());
    }
    return next;
  }, [isOwner, workspace]);
  useEffect(() => {
    if (!membersOpen || !isOwner || detail?.record.status !== 'active') return;
    let current = true;
    void readRequests().then(next => { if (current) { setRequests(next); setRequestRead('loaded'); } })
      .catch(cause => { if (current) { setRequestError(userMessage(cause)); setRequestRead('error'); } });
    return () => { current = false; };
  }, [membersOpen, isOwner, detail?.record.status, readRequests, requestAttempt]);
  const reloadRequests = () => { setRequestRead('loading'); setRequestError(null); setRequestAttempt(value => value + 1); };
  if (workspace.protocol === 'migration') return <LegacyMigrationPanel workspace={workspace} run={run} busy={busy} />;
  if (!detail) return loadError ? <Card><Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
    <AppButton title="もう一度読み込む" variant="secondary" onPress={() => { setLoadError(null); setReadAttempt(value => value + 1); }} />
  </Card> : <Card><ActivityIndicator color={palette.accent} /></Card>;
  const { record, snapshot } = detail;
  return <>
    <ScreenHeading title="グループ設定" description={record.displayName} />
    {loadError ? <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text> : null}
    {record.lastErrorCode ? <Text accessibilityRole="alert" style={styles.error}>{sharingFailureMessage({ code: record.lastErrorCode })}</Text> : null}
    {detail.openError ? <Text accessibilityRole="alert" style={styles.error}>{detail.openError}</Text> : null}
    {record.status === 'joining' && record.join ? <Card><Text style={styles.label}>参加の承認待ち</Text><Text style={styles.caption}>所有者の画面と確認番号を照合してください。</Text><Text selectable style={styles.verification}>{sharedJoinVerificationCode(record.join.request)}</Text></Card> : null}
    {snapshot ? <AccordionSection title="家事ごとの設定" expanded={choreSettingsOpen} onToggle={() => setChoreSettingsOpen(value => !value)}>
      <ChoreSettingsSources first="group" group={workspace} />
      <GroupManagementLinks section="chores" busy={busy} onSelect={target => router.push(target)} />
    </AccordionSection> : null}
    {workspace.protocol === 2 && record.status === 'active' ? <Card><SectionHeading title="申請・承認" level="subsection" /><GroupManagementLinks section="requests" busy={busy} onSelect={target => router.push(target)} /></Card> : null}
    {snapshot ? <AccordionSection title={`メンバー・招待（${roster?.body.members.length ?? 0}人）`} expanded={membersOpen} onToggle={() => {
      if (!membersOpen) { setRequestRead('loading'); setRequestError(null); }
      setMembersOpen(value => !value);
    }}>

      {roster?.body.members.map((member) => <View key={member.userId} style={styles.member}>
        <Text style={styles.label}>{snapshot.members.find((item) => item.id === member.userId)?.displayName ?? 'メンバー'}{member.userId === workspace.userId ? '（自分）' : ''}{member.userId === roster.body.ownerUserId ? ' · 所有者' : ''}</Text>
        <Text style={styles.caption}>参加端末：{member.devices.length}台</Text>
        {isOwner && manager ? member.devices.filter((device) => device.identity.deviceId !== workspace.identity.deviceId).map((device, index) => <AppButton key={device.identity.deviceId}
          title={`${member.devices.length > 1 ? `端末${index + 1}へ` : 'このメンバーへ'}所有者を引き継ぐ`} compact variant="quiet" disabled={busy}
          onPress={() => Alert.alert('所有者を引き継ぎますか？', 'メンバーの招待・除名は、引き継ぎ先の端末から行うようになります。', [{ text: 'キャンセル', style: 'cancel' },
            { text: '引き継ぐ', onPress: () => void run(async () => { await manager.transferOwnership({ userId: member.userId, deviceId: device.identity.deviceId }); await refresh(); }) }])} />) : null}
        {isOwner && manager && member.userId !== roster.body.ownerUserId ? <AppButton title="このメンバーを除名" compact variant="danger" disabled={busy}
          onPress={() => Alert.alert('メンバーを除名しますか？', '今後の共有データへアクセスできなくなります。すでに相手の端末に保存された内容は消去できません。', [{ text: 'キャンセル', style: 'cancel' },
            { text: '除名する', style: 'destructive', onPress: () => void run(async () => { await manager.removeMembers([member.userId]); await refresh(); }) }])} /> : null}
        {isOwner && manager && member.devices.length > 1 ? member.devices.filter((device) => device.identity.deviceId !== workspace.identity.deviceId).map((device, index) => <AppButton key={`remove:${device.identity.deviceId}`}
          title={`端末${index + 1}の参加を解除`} compact variant="danger" disabled={busy}
          onPress={() => Alert.alert('この端末の参加を解除しますか？', 'ほかの端末は引き続き使えます。解除した端末の保存済みデータは消去できません。', [{ text: 'キャンセル', style: 'cancel' },
            { text: '解除する', style: 'destructive', onPress: () => void run(async () => { await manager.removeDevice(device.identity.deviceId); await refresh(); }) }])} />) : null}
      </View>)}
    {isOwner && manager && record.status === 'active' ? <View style={styles.invitation}><SectionHeading title="招待・参加の承認" level="subsection" />
      <AppButton title="招待リンクとQRを作る" disabled={busy} onPress={() => void run(async () => { setInvite(await manager.createInvitation()); })} />
      {invite ? <>
        {qr ? failedQr === qr.uri ? <Text style={styles.error}>QRコードを表示できません。招待リンクを共有してください。</Text>
          : <Image source={{ uri: qr.uri }} style={styles.qr} contentFit="contain" cachePolicy="none" onError={() => setFailedQr(qr.uri)} accessibilityLabel="共有グループの招待QRコード" />
          : <Text style={styles.error}>この招待は期限が切れています。</Text>}
        <Text style={styles.caption}>有効期限：{new Date(invite.invitation.body.expiresAt).toLocaleString('ja-JP')}。信頼する相手にだけ渡してください。</Text>
        {qr ? <AppButton title="招待リンクを共有" variant="secondary" disabled={busy} onPress={() => void Share.share({ message: invite.url }).catch(() => undefined)} /> : null}
        <AppButton title="この招待を取り消す" variant="quiet" disabled={busy} onPress={() => void run(async () => { await workspace.cloud.revokeInvitation(invite.invitation.body.inviteId); setInvite(null); reloadRequests(); })} />
      </> : null}
      {requestRead === 'idle' || requestRead === 'loading' ? <ActivityIndicator accessibilityLabel="参加申請を確認中" color={palette.accent} /> : null}
      {requestError ? <Text accessibilityRole="alert" style={styles.error}>{requestError}</Text> : null}
      {requestRead === 'loaded' && !requests.length ? <Text style={styles.caption}>参加申請はありません。</Text> : null}
      <AppButton title={requestError ? '参加申請を再試行' : '参加申請を再読込'} compact variant="quiet" disabled={busy || requestRead === 'loading'} onPress={reloadRequests} />
      {requests.map(({ invitation, request }) => <Card key={`${invitation.body.inviteId}:${request.body.userId}`}>
        <Text style={styles.label}>参加申請</Text><Text selectable style={styles.verification}>{sharedJoinVerificationCode(request)}</Text>
        <Text style={styles.caption}>相手の端末にも同じ番号が表示されていることを確認してください。</Text>
        <AppButton title="この端末の参加を承認" disabled={busy || requestRead !== 'loaded'} onPress={() => void run(async () => { await manager.approve(invitation, request); reloadRequests(); await refresh(); })} />
        <AppButton title="申請を拒否" variant="quiet" disabled={busy || requestRead !== 'loaded'} onPress={() => void run(async () => { await workspace.cloud.withdrawOrRejectJoinRequest(invitation.body.inviteId, request.body.userId); reloadRequests(); })} />
      </Card>)}
    </View> : null}
    </AccordionSection> : null}
    {workspace.protocol === 2 && ['active', 'creating'].includes(record.status) ? <GroupManagementLinks section="common" busy={busy} onSelect={target => router.push(target)} /> : null}
    <AccordionSection title={detail.pending ? `同期（未送信${detail.pending}件）` : '同期（未送信なし）'} expanded={syncOpen} onToggle={() => setSyncOpen(value => !value)}>
      <Text style={styles.caption}>最終同期：{record.lastSuccessfulSyncAt ? new Date(record.lastSuccessfulSyncAt).toLocaleString('ja-JP') : '未実施'}</Text>
      <Text style={styles.caption}>相手の端末への反映は、その端末が同期したときに行われます。</Text>
      <AppButton title="今すぐ同期" compact variant="secondary" disabled={busy || ['left', 'removed'].includes(record.status)} onPress={() => void run(async () => { await workspace.sync({ force: true, budgetMs: 120_000 }); await refresh(); if (membersOpen) reloadRequests(); })} />
      {snapshot ? <Text style={styles.caption}>グループの地域：{snapshot.timeZone}</Text> : null}
    </AccordionSection>
    {snapshot?.recoverySummary?.heldChanges ? <Text accessibilityRole="alert" style={styles.error}>確認待ちの変更が{snapshot.recoverySummary.heldChanges}件あります。「更新・復旧」から確認してください。</Text> : null}
    {workspace.protocol === 2 && record.status === 'active' ? <AccordionSection title="更新・復旧" expanded={maintenanceOpen} onToggle={() => setMaintenanceOpen(value => !value)}>
    {workspace.protocol === 2 && roster?.body.schedulerVersion !== V2_SCHEDULER_VERSION ? <Card>
      <Text style={styles.body}>共有カレンダーに対応する互換更新があります。家事・設定・履歴を保持して、所有者が更新できます。全メンバーのアプリを先に更新してください。</Text>
      {isOwner && manager ? <AppButton title="共有グループを互換更新" disabled={busy} onPress={() => Alert.alert('共有グループを更新しますか？',
        '全メンバーのアプリ更新後に進めてください。旧版のアプリは更新後のグループを同期できません。保存済みデータは保持します。',
        [{ text: 'キャンセル', style: 'cancel' }, { text: '更新する', onPress: () => void run(async () => { await manager.upgradeScheduler(); await refresh(); }) }])} /> : null}
    </Card> : null}
    {workspace.protocol === 2 && record.status === 'active' ? <V2RecoveryPanel groupId={workspace.groupId} recovery={workspace.session.recovery}
      isOwner={isOwner} busy={busy} run={run} devices={roster?.body.members.flatMap(member => member.devices.map(device => ({ deviceId: device.identity.deviceId,
        displayName: snapshot?.members.find(item => item.id === member.userId)?.displayName ?? 'メンバー' }))) ?? []} /> : null}
    </AccordionSection> : null}
    <View style={styles.exit}>
      {record.status === 'joining' && record.join ? <AppButton title="参加申請を取り消す" variant="danger" disabled={busy} onPress={() => void run(async () => {
        await workspace.cancelJoinRequest(); await context.refreshSharing(); router.replace('/sharing');
      })} /> : manager ? <AppButton title="グループから退出" compact variant="danger" disabled={busy || ['left', 'removed'].includes(record.status)}
        onPress={() => Alert.alert('グループから退出しますか？', detail.pending ? `未送信の変更が${detail.pending}件あります。退出後は送信できません。端末内の記録は保持します。` : '共有データの取得と送信を終了します。',
          [{ text: 'キャンセル', style: 'cancel' }, { text: '退出する', style: 'destructive', onPress: () => void run(async () => { await manager.leave(); await context.refreshSharing(); router.replace('/sharing'); }) }])} /> : null}
    </View>
  </>;
}

function userMessage(error: unknown): string {
  return error instanceof Error && /[ぁ-んァ-ヶ一-龯]/u.test(error.message) ? error.message : sharingFailureMessage(error);
}
const styles = StyleSheet.create({
  body: { ...typography.body, color: palette.ink }, label: { ...typography.subheading, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.label, color: palette.warning },
  input: { ...typography.body, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 12, color: palette.ink },
  multiline: { minHeight: 90, maxHeight: 160, textAlignVertical: 'top' }, buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  invitation: { gap: 10, marginTop: 8 }, exit: { alignSelf: 'flex-start', marginTop: 8 },
  member: { gap: 7, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  candidate: { gap: 8, padding: 12, backgroundColor: palette.accentSoft, borderRadius: 12 },
  verification: { ...typography.section, fontWeight: '700', color: palette.ink, fontVariant: ['tabular-nums'], letterSpacing: 1.5 },
  qr: { width: '100%', maxWidth: 330, aspectRatio: 1, alignSelf: 'center', backgroundColor: '#FFFFFF' },
});
