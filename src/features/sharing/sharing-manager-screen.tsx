import { GroupManagementLinks } from './group-management-links';
import { GroupRequestSections } from './group-request-sections';
import { V2_SCHEDULER_VERSION } from '@/features/sharing/v2/payload-schema';
import { FormTextInput as TextInput } from '../../components/form-text-input';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Share, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { AppButton, Card, Page, palette, typography } from '@/components/planner-ui';
import { AccordionSection } from '@/components/accordion-section';
import { ChoreSettingsSources } from '@/features/settings/chore-settings-sources';
import { useWorkspace } from '@/hooks/use-workspace';
import { enableSharingSession, createV2SharingWorkspace, openSharedWorkspace, requestSharingWorkspace, sharingFailureMessage, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import { GroupCreationForm } from '@/features/sharing/group-creation-form';
import { sharingCreationProtocol } from '@/features/sharing/rollout';
import type { SharedWorkspace } from '@/platform/sharing/workspaces';
import type { SharedWorkspaceOverview } from '@/platform/sharing/workspace-types';
import { isSharingConfigured } from '@/platform/sharing/firebase-services';
import { isSharingAppleSignInAvailable, signInSharingWithApple, signInSharingWithGoogle } from '@/platform/sharing/auth';
import { sharingInvitationQr } from '@/features/sharing/invitation-qr';
import { sharedJoinVerificationCode } from '@/features/sharing/invitations';
import type { SharedJoinRequest, SignedSharedInvitation } from '@/features/sharing/invitations';
import { LegacyMigrationPanel } from '@/features/sharing/v2/legacy-migration-panel';
import { V2RecoveryPanel } from '@/features/sharing/v2/recovery-panel';
import { SettingsHeader, SettingsList, SettingsRow } from '@/features/settings/settings-navigation';
import { SettingsAction, SettingsGroup, SettingsSegments } from '@/components/settings-controls';
import { groupSettingsDestination, groupSettingsSection, groupSettingsTitles, type GroupSettingsSection } from './group-settings-sections';
import { plannerColorsForScheme } from '@/components/planner-theme';
import { SHARING_HELP_PARAGRAPHS } from '@/features/help/help-content';
import { v2MemberLabels } from './v2-ui/member-labels';

export default function SharingScreen({ detailOnly = false }: { detailOnly?: boolean }) {
  const context = useWorkspace(); const params = useLocalSearchParams<{ groupId?: string; section?: string }>();
  const section = groupSettingsSection(params.section);
  const colors = plannerColorsForScheme(useColorScheme());
  const [invitation, setInvitation] = useState({ userId: context.userId, value: '' });
  const link = invitation.userId === context.userId ? invitation.value : '';
  const setLink = (value: string) => setInvitation({ userId: context.userId, value });
  const [entryMode, setEntryMode] = useState<'join' | 'create'>('join');
  const [expanded, setExpanded] = useState<string | null>(null);
  const selectedId = typeof params.groupId === 'string' ? params.groupId : context.group?.groupId ?? null;
  const [selected, setSelected] = useState<SharedWorkspace | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
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
    if (!detailOnly && isSharingConfigured()) void enableSharingSession().then(context.refreshSharing).catch(() => undefined);
    if (!detailOnly) void isSharingAppleSignInAvailable().then(setAppleAvailable).catch(() => undefined);
    return () => { alive.current = false; };
  }, [context.refreshSharing, detailOnly]);
  useEffect(() => {
    let current = true;
    if (canOpenSelected && selectedId && context.userId) void openSharedWorkspace({ userId: context.userId, groupId: selectedId })
      .then((workspace) => { if (current) setSelected(workspace); }).catch((cause) => { if (current) setMessage(userMessage(cause)); });
    return () => { current = false; };
  }, [canOpenSelected, context.userId, selectedId, selectedRevision, openAttempt]);
  if (detailOnly) return <Page keyboardAware header={<SettingsHeader title={section ? groupSettingsTitles[section] : 'グループ設定'} onBack={() => {
    if (router.canGoBack()) router.back();
    else if (section && selectedId) router.replace({ pathname: '/sharing/group/[groupId]', params: { groupId: selectedId } });
    else router.replace('/sharing');
  }} />} contentStyle={styles.settingsPage}>

    {message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null}
    {!context.userId ? <Card><Text style={styles.body}>グループを管理するアカウントへログインしてください。</Text><AppButton title="ログイン" onPress={() => router.replace('/sharing')} /></Card>
      : selected && selected.groupId === selectedId && selected.userId === context.userId ? <GroupDetail key={`${selected.userId}:${selected.groupId}:${selected.identity.deviceId}:${selected.protocol}:${section ?? 'index'}`} workspace={selected} section={section} run={run} busy={busy} />
      : !selectedRecord ? <Text style={styles.body}>現在の所属グループを確認してください。</Text>
        : message ? <SettingsAction title="グループ設定を再読込" placement="page" onPress={() => { setMessage(null); setOpenAttempt(attempt => attempt + 1); }} />
        : <ActivityIndicator color={palette.accent} />}
  </Page>;
  const sharingHelp = <AccordionSection plain title="共有について" expanded={expanded === 'help'} onToggle={() => setExpanded(expanded === 'help' ? null : 'help')}>
    {SHARING_HELP_PARAGRAPHS.map(paragraph => <Text key={paragraph} style={styles.body}>{paragraph}</Text>)}
  </AccordionSection>;
  return <Page keyboardAware header={<SettingsHeader title="共有グループ" onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />} contentStyle={styles.entryPage}>
    {!context.group ? <View style={styles.entryIntro}>
      <Text style={styles.body}>家族や同居人と、家事を共有できます。</Text>
      <Text style={styles.caption}>個人の家事・予定は共有されません。</Text>
    </View> : null}
    {!context.userId ? sharingHelp : null}
    {!isSharingConfigured() ? <Text accessibilityRole="alert" style={styles.error}>このビルドは共有先が未設定です。</Text> : !context.userId ? <View style={styles.entryForm}>
      <AppButton title="Googleで続ける" disabled={busy} onPress={() => void run(async () => { await signInSharingWithGoogle(); })} />
      {appleAvailable ? <AppButton title="Appleで続ける" variant="secondary" disabled={busy} onPress={() => void run(async () => { await signInSharingWithApple(); })} /> : null}
    </View> : <>
      {context.group ? <Card>
        <Text style={styles.label}>{context.group.displayName}</Text>
        <Text style={styles.caption}>{context.group.status === 'joining' ? '管理者の承認待ち' : context.group.status === 'creating' ? '端末に保存済み · 共有先への作成待ち' : '参加中'}</Text>
        <AppButton title="グループを管理" compact variant="secondary" disabled={busy} onPress={() => router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: context.group!.groupId } })} />
      </Card> : <>
        {context.restoration === 'waiting' || context.restoration === 'failed' ? <Text style={styles.caption} accessibilityRole={context.restoration === 'failed' ? 'alert' : undefined}>
          {context.restoration === 'waiting' ? 'グループを復元中です。以前の端末が接続すると自動で参加します。' : 'グループの復元を再試行します。以前の端末も接続してください。'}</Text> : null}
      <View style={styles.entryTabs}><SettingsSegments<'join' | 'create'> wide options={[{ id: 'join', label: '参加する' }, { id: 'create', label: '作成する' }]}
        value={entryMode} onValueChange={setEntryMode} disabled={busy} /></View>
      <View accessibilityElementsHidden={entryMode !== 'create'} importantForAccessibility={entryMode !== 'create' ? 'no-hide-descendants' : 'auto'} style={entryMode !== 'create' ? styles.hiddenEntry : styles.entryForm}>
        <GroupCreationForm key={context.userId} protocol={creationProtocol} busy={busy || entryMode !== 'create'} onCreate={(name, kind) => run(async () => {
          const owner = context.userId;
          const workspace = await createV2SharingWorkspace(name, kind!);
          if (alive.current && currentUserId.current === owner) { setExpanded(null); router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: workspace.groupId } }); }
        })} />
      </View>
      <View accessibilityElementsHidden={entryMode !== 'join'} importantForAccessibility={entryMode !== 'join' ? 'no-hide-descendants' : 'auto'} style={entryMode !== 'join' ? styles.hiddenEntry : styles.entryForm}>
        <TextInput style={[styles.input, styles.multiline, { borderColor: colors.inputBorder, backgroundColor: colors.elevated, color: colors.ink }]} multiline value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false}
          placeholder="招待リンクを貼り付け" accessibilityLabel="招待リンク" editable={!busy && entryMode === 'join'} />
        <Text style={styles.caption}>グループの管理者が承認すると参加できます。</Text>
        <AppButton title="参加を申請" disabled={busy || entryMode !== 'join' || !link.trim()} onPress={() => void run(async () => {
          const owner = context.userId; const workspace = await requestSharingWorkspace(link);
          if (alive.current && currentUserId.current === owner) { setLink(''); setExpanded(null); router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: workspace.groupId } }); }
        })} />
      </View>
      </>}
    </>}
    {busy ? <ActivityIndicator color={palette.accent} /> : null}
    {message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null}
  </Page>;
}

export function GroupDetail({ workspace, run, busy, section }: { workspace: SharedWorkspace; run: (work: () => Promise<void>) => Promise<boolean>; busy: boolean; section?: GroupSettingsSection }) {
  const context = useWorkspace();
  const colors = plannerColorsForScheme(useColorScheme());
  const [detail, setDetail] = useState<{ record: Awaited<ReturnType<SharedWorkspace['record']>>; pending: number;
    snapshot: SharedWorkspaceOverview | null; openError: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requests, setRequests] = useState<{ invitation: SignedSharedInvitation; request: SharedJoinRequest }[]>([]);
  const [invalidRequests, setInvalidRequests] = useState<{ invitation: SignedSharedInvitation; userId: string }[]>([]);
  const [requestCursors, setRequestCursors] = useState<{ invitation: SignedSharedInvitation; after: string }[]>([]);
  const [requestRead, setRequestRead] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestAttempt, setRequestAttempt] = useState(0);
  const [openInvitations, setOpenInvitations] = useState<{ invitation: SignedSharedInvitation; createdAtMs: number | null }[]>([]);
  const manager = workspace.manager;
  const [invite, setInvite] = useState<Awaited<ReturnType<NonNullable<SharedWorkspace['manager']>['createInvitation']>> | null>(null);
  const [failedQr, setFailedQr] = useState<string | null>(null);
  const [shareError, setShareError] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const membersOpen = section === 'members';
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
  const refresh = useCallback(async () => { const next = await load(); if (currentWorkspace.current === workspace) { setDetail(next); setLoadError(null); } }, [load, workspace]);
  useFocusEffect(useCallback(() => {
    let current = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => { void load().then((next) => { if (current) { setDetail(next); setLoadError(null); } })
      .catch((cause) => { if (current) setLoadError(userMessage(cause)); }); };
    read(); const unsubscribe = subscribeSharingChanges((scope) => { if (scope?.userId === workspace.userId && scope.groupId === workspace.groupId) { clearTimeout(timer); timer = setTimeout(read, 80); } });
    return () => { current = false; clearTimeout(timer); unsubscribe(); };
  }, [load, workspace]));
  useEffect(() => {
    const latestExpiry = invite?.invitation.body.expiresAt ?? 0;
    const expiresAt = openInvitations.reduce((nearest, entry) => {
      const expiry = entry.invitation.body.expiresAt;
      return expiry > clock ? Math.min(nearest, expiry) : nearest;
    }, latestExpiry > clock ? latestExpiry : Infinity);
    if (Number.isFinite(expiresAt)) {
      const timer = setTimeout(() => setClock(Date.now()), Math.max(1, expiresAt - Date.now()));
      return () => clearTimeout(timer);
    }
  }, [clock, invite, openInvitations]);
  const preparedQr = useMemo(() => {
    try { return invite ? sharingInvitationQr(invite.url) : null; } catch { return null; }
  }, [invite]);
  const activeInvite = invite && invite.invitation.body.expiresAt > clock ? invite : null;
  const qr = activeInvite ? preparedQr : null;
  const roster = workspace.roster(); const isOwner = roster?.body.ownerDeviceId === workspace.identity.deviceId;
  const readRequests = useCallback(async (sources: readonly { invitation: SignedSharedInvitation; after?: string }[]) => {
    if (!isOwner) return { next: [], invalid: [], cursors: [] };
    const next: { invitation: SignedSharedInvitation; request: SharedJoinRequest }[] = [];
    const invalid: typeof invalidRequests = []; const cursors: typeof requestCursors = [];
    for (let offset = 0; offset < sources.length; offset += 4) {
      const pages = await Promise.all(sources.slice(offset, offset + 4).map(async item => ({ invitation: item.invitation,
        result: await workspace.cloud.listJoinRequests(item.invitation, item.after) })));
      for (const { invitation, result } of pages) {
        next.push(...result.requests.map(request => ({ invitation, request })));
        invalid.push(...result.invalidUserIds.map(userId => ({ invitation, userId })));
        if (result.nextCursor) cursors.push({ invitation, after: result.nextCursor });
      }
    }
    return { next, invalid, cursors };
  }, [isOwner, workspace]);
  useEffect(() => {
    if (!membersOpen || !isOwner || detail?.record.status !== 'active') return;
    let current = true;
    const read = async () => {
      const entries = await workspace.cloud.listInvitations(workspace.groupId, { activeAtMs: Date.now() });
      const now = Date.now();
      const active = entries.filter(entry => entry.status === 'open' && entry.invitation.body.expiresAt > now);
      if (!current) return;
      setOpenInvitations(active);
      setClock(now);
      const { next, invalid, cursors } = await readRequests(active);
      if (current) { setRequests(next); setInvalidRequests(invalid); setRequestCursors(cursors); setRequestRead('loaded'); }
    };
    void read()
      .catch(cause => { if (current) { setRequestError(userMessage(cause)); setRequestRead('error'); } });
    return () => { current = false; };
  }, [membersOpen, isOwner, detail?.record.status, readRequests, requestAttempt, workspace]);
  const reloadRequests = () => { setRequestRead('loading'); setRequestError(null); setRequestAttempt(value => value + 1); };
  if (workspace.protocol === 'migration') return <LegacyMigrationPanel workspace={workspace} run={run} busy={busy} />;
  if (!detail) return loadError ? <Card><Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
    <SettingsAction title="もう一度読み込む" placement="page" onPress={() => { setLoadError(null); void refresh().catch(cause => { if (currentWorkspace.current === workspace) setLoadError(userMessage(cause)); }); }} />
  </Card> : <Card><ActivityIndicator color={palette.accent} /></Card>;
  const { record, snapshot } = detail;
  const joinEnded = record.status === 'joining' && (record.lastErrorCode === 'sharing/invitation-rejected' || record.lastErrorCode === 'sharing/invitation-ended');
  const memberName = v2MemberLabels(snapshot?.members.map(member => ({ userId: member.id, displayName: member.displayName })) ?? []);
  const deviceName = (id: string) => `端末 ${id.slice(-8)}`;
  return <>
    {loadError ? <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text> : null}
    {record.lastErrorCode ? <Text accessibilityRole="alert" style={styles.error}>{sharingFailureMessage({ code: record.lastErrorCode })}</Text> : null}
    {detail.openError ? <Text accessibilityRole="alert" style={styles.error}>{detail.openError}</Text> : null}
    {record.status === 'joining' && record.join && !joinEnded ? <Card><Text style={styles.label}>参加の承認待ち</Text><Text style={styles.caption}>管理者の画面と確認番号を照合してください。</Text><Text selectable style={styles.verification}>{sharedJoinVerificationCode(record.join.request)}</Text></Card> : null}
    {!section ? <SettingsList>
      {snapshot ? <SettingsRow title={groupSettingsTitles.chores} disabled={busy} onPress={() => router.push(groupSettingsDestination(workspace.groupId, 'chores'))} /> : null}
      {snapshot ? <SettingsRow title={groupSettingsTitles.members} summary={`${roster?.body.members.length ?? 0}人`} disabled={busy} onPress={() => router.push(groupSettingsDestination(workspace.groupId, 'members'))} /> : null}
      {workspace.protocol === 2 && ['active', 'creating'].includes(record.status) ? <GroupManagementLinks list section="common" busy={busy} onSelect={target => router.push(target)} /> : null}
    </SettingsList> : null}
    {section === 'chores' && snapshot ? <>
      <ChoreSettingsSources first="group" group={workspace} />
    </> : null}
    {(!section || section === 'requests') && workspace.protocol === 2 && record.status === 'active' ? <GroupRequestSections key={`${workspace.userId}:${workspace.groupId}`} workspace={workspace} busy={busy} run={run} compact={!section} /> : null}
    {membersOpen && snapshot ? <>
      <SettingsGroup title="メンバー">
      {roster?.body.members.map((member) => <View key={member.userId} style={[styles.member, { borderBottomColor: colors.border }]}>
        <View style={styles.memberHeader}>
          <Text style={styles.memberName}>{memberName(member.userId)}{member.userId === workspace.userId ? <Text style={styles.caption}>（自分）</Text> : null}</Text>
          {member.userId === roster.body.ownerUserId ? <Text style={styles.caption}>管理者</Text> : null}
        </View>
        {member.devices.length > 1 || member.userId === workspace.userId ? <Text style={styles.caption}>{member.devices.map(device =>
          `${deviceName(device.identity.deviceId)}${device.identity.deviceId === workspace.identity.deviceId ? '（この端末）' : ''}`).join(' · ')}</Text> : null}
        {isOwner && manager && (member.devices.some(device => device.identity.deviceId !== workspace.identity.deviceId) || member.userId !== roster.body.ownerUserId) ? <View style={styles.buttons}>
        {isOwner && manager ? member.devices.filter((device) => device.identity.deviceId !== workspace.identity.deviceId).map(device => <SettingsAction key={device.identity.deviceId}
          title={`${member.devices.length > 1 ? `${deviceName(device.identity.deviceId)}へ` : 'このメンバーへ'}管理者権限を引き継ぐ`}
          accessibilityLabel={`${memberName(member.userId)}の${deviceName(device.identity.deviceId)}に管理者権限を引き継ぐ`} compact disabled={busy}
          onPress={() => Alert.alert('管理者権限を引き継ぎますか？', `${memberName(member.userId)}の${deviceName(device.identity.deviceId)}が管理者端末になります。`, [{ text: 'キャンセル', style: 'cancel' },
            { text: '引き継ぐ', onPress: () => void run(async () => { await manager.transferOwnership({ userId: member.userId, deviceId: device.identity.deviceId }); await refresh(); }) }])} />) : null}
        {isOwner && manager && member.userId !== roster.body.ownerUserId ? <SettingsAction title="このメンバーを除名" accessibilityLabel={`${memberName(member.userId)}を除名`} compact intent="destructive" disabled={busy}
          onPress={() => Alert.alert(`${memberName(member.userId)}を除名しますか？`, '今後の共有データへアクセスできなくなります。すでに相手の端末に保存された内容は消去できません。', [{ text: 'キャンセル', style: 'cancel' },
            { text: '除名する', style: 'destructive', onPress: () => void run(async () => { await manager.removeMembers([member.userId]); await refresh(); }) }])} /> : null}
        {isOwner && manager && member.devices.length > 1 ? member.devices.filter((device) => device.identity.deviceId !== workspace.identity.deviceId).map(device => <SettingsAction key={`remove:${device.identity.deviceId}`}
          title={`${deviceName(device.identity.deviceId)}の参加を解除`} accessibilityLabel={`${memberName(member.userId)}の${deviceName(device.identity.deviceId)}の参加を解除`} compact intent="destructive" disabled={busy}
          onPress={() => Alert.alert(`${memberName(member.userId)}の${deviceName(device.identity.deviceId)}を解除しますか？`, 'ほかの端末は引き続き使えます。解除した端末の保存済みデータは消去できません。', [{ text: 'キャンセル', style: 'cancel' },
            { text: '解除する', style: 'destructive', onPress: () => void run(async () => { await manager.removeDevice(device.identity.deviceId); await refresh(); }) }])} />) : null}
        </View> : null}
      </View>)}
      </SettingsGroup>
    {isOwner && manager && record.status === 'active' ? <>
      <SettingsGroup title="参加申請" action={<SettingsAction title={requestError ? '再試行' : '再読込'} accessibilityLabel={requestError ? '参加申請を再試行' : '参加申請を再読込'} placement="page" disabled={busy || requestRead === 'loading'} onPress={reloadRequests} />}>
      {requestRead === 'idle' || requestRead === 'loading' ? <ActivityIndicator accessibilityLabel="参加申請を確認中" color={palette.accent} /> : null}
      {requestError ? <Text accessibilityRole="alert" style={styles.error}>{requestError}</Text> : null}
      {requestRead === 'loaded' && !requests.length && !invalidRequests.length && !requestCursors.length ? <Text style={styles.caption}>申請はありません。</Text> : null}
      {requestCursors.length ? <SettingsAction title="参加申請の続きを取得" compact disabled={busy || requestRead !== 'loaded'} onPress={() => void run(async () => {
        const page = await readRequests(requestCursors);
        if (currentWorkspace.current !== workspace) return;
        setRequests(previous => [...new Map([...previous, ...page.next].map(item => [`${item.invitation.body.inviteId}:${item.request.body.userId}`, item])).values()]);
        setInvalidRequests(previous => [...new Map([...previous, ...page.invalid].map(item => [`${item.invitation.body.inviteId}:${item.userId}`, item])).values()]);
        setRequestCursors(page.cursors);
      })} /> : null}
      {invalidRequests.length ? <View><Text accessibilityRole="alert" style={styles.caption}>確認できない参加申請：{invalidRequests.length}件</Text>
        <SettingsAction title="確認できない申請を削除" intent="destructive" compact disabled={busy || requestRead !== 'loaded'} onPress={() => void run(async () => {
          const batch = invalidRequests.slice(0, 100);
          for (let offset = 0; offset < batch.length; offset += 4) {
            const slice = batch.slice(offset, offset + 4);
            const results = await Promise.allSettled(slice.map(item => workspace.cloud.withdrawOrRejectJoinRequest(item.invitation.body.inviteId, item.userId)));
            if (currentWorkspace.current !== workspace) return;
            const done = new Set(slice.filter((_, index) => results[index].status === 'fulfilled'));
            setInvalidRequests(previous => previous.filter(row => !done.has(row)));
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          }
        })} /></View> : null}
      {requests.map(({ invitation, request }) => <Card key={`${invitation.body.inviteId}:${request.body.userId}`}>
        <Text style={styles.label}>参加申請</Text><Text selectable style={styles.verification}>{sharedJoinVerificationCode(request)}</Text>
        <Text style={styles.caption}>相手の端末にも同じ番号が表示されていることを確認してください。</Text>
        <SettingsAction title="この端末の参加を承認" intent="primary" disabled={busy || requestRead !== 'loaded'} onPress={() => void run(async () => { await manager.approve(invitation, request); reloadRequests(); await refresh(); })} />
        <SettingsAction title="申請を拒否" intent="destructive" disabled={busy || requestRead !== 'loaded'} onPress={() => void run(async () => { await workspace.cloud.withdrawOrRejectJoinRequest(invitation.body.inviteId, request.body.userId); reloadRequests(); })} />
      </Card>)}
      </SettingsGroup>
      <SettingsGroup title="招待リンク">
      <SettingsAction title="メンバーを招待" accessibilityLabel="招待リンクとQRを作る" placement="page" compact={false} disabled={busy} onPress={() => void run(async () => {
        const next = await manager.createInvitation();
        if (currentWorkspace.current !== workspace) return;
        const now = Date.now();
        setInvite(next); setClock(now); setShareError(false);
        setOpenInvitations(previous => [{ invitation: next.invitation, createdAtMs: now }, ...previous.filter(entry => entry.invitation.body.inviteId !== next.invitation.body.inviteId)]);
        reloadRequests();
      })} />
      {invite ? <>
        {activeInvite ? qr && failedQr !== qr.uri
          ? <Image source={{ uri: qr.uri }} style={styles.qr} contentFit="contain" cachePolicy="none" onError={() => setFailedQr(qr.uri)} accessibilityLabel="共有グループの招待QRコード" />
          : <Text style={styles.error}>QRコードを表示できません。招待リンクを共有できます。</Text>
          : <Text style={styles.error}>この招待は期限が切れています。</Text>}
        <Text style={styles.caption}>有効期限：{new Date(invite.invitation.body.expiresAt).toLocaleString('ja-JP')}。信頼する相手にだけ渡してください。</Text>
        {activeInvite ? <SettingsAction placement="page" title="招待リンクを共有" disabled={busy} onPress={() => {
          if (Date.now() >= activeInvite.invitation.body.expiresAt) { setClock(Date.now()); return; }
          setShareError(false);
          void Share.share({ message: activeInvite.url }).catch(() => { if (currentWorkspace.current === workspace) setShareError(true); });
        }} /> : null}
        {shareError && activeInvite ? <Text accessibilityRole="alert" style={styles.error}>共有画面を開けませんでした。もう一度お試しください。</Text> : null}
      </> : null}
      {openInvitations.filter(entry => entry.invitation.body.expiresAt > clock).map(({ invitation, createdAtMs }) => {
        const { inviteId, expiresAt } = invitation.body;
        const label = `招待 ${inviteId.slice(-6)}`;
        const dateLabel = (value: number) => new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return <View key={inviteId} style={styles.invitationRow}>
          <View style={styles.invitationText}><Text style={styles.label}>{label}</Text>
            <Text style={styles.caption}>{createdAtMs != null ? `${dateLabel(createdAtMs)}に発行 · ` : ''}{dateLabel(expiresAt)}まで</Text></View>
          <SettingsAction title="取り消す" accessibilityLabel={`${label}を取り消す`} intent="destructive" disabled={busy}
            onPress={() => Alert.alert(`${label}を取り消しますか？`, 'このリンクから新しい参加申請はできなくなります。', [
              { text: 'キャンセル', style: 'cancel' }, { text: '取り消す', style: 'destructive', onPress: () => void run(async () => {
                await workspace.cloud.revokeInvitation(inviteId);
                if (currentWorkspace.current !== workspace) return;
                setOpenInvitations(previous => previous.filter(entry => entry.invitation.body.inviteId !== inviteId));
                setInvite(previous => previous?.invitation.body.inviteId === inviteId ? null : previous);
                reloadRequests();
              }) },
            ])} />
        </View>;
      })}
      </SettingsGroup>
    </> : null}
    </> : null}
    {(!section || section === 'sync') ? <SettingsGroup title="同期・復旧">
      {detail.pending ? <Text style={styles.body}>未送信：{detail.pending}件</Text> : null}
      <Text style={styles.caption}>最終同期：{record.lastSuccessfulSyncAt ? new Date(record.lastSuccessfulSyncAt).toLocaleString('ja-JP') : '未実施'}</Text>
      {roster && roster.body.members.reduce((count, member) => count + member.devices.length, 0) > 1 ? <Text style={styles.caption}>ほかの端末の同期後に反映されます。</Text> : null}
      <SettingsAction title="今すぐ同期" compact disabled={busy || ['left', 'removed'].includes(record.status)} onPress={() => void run(async () => { await workspace.sync({ force: true, budgetMs: 120_000 }); await refresh(); })} />
    {workspace.protocol === 2 && record.status === 'active' ? <>
    {workspace.protocol === 2 && roster?.body.schedulerVersion !== V2_SCHEDULER_VERSION ? <Card>
      <Text style={styles.body}>共有機能の更新があります。家事・設定・履歴を保持して、管理者が更新できます。全メンバーのアプリを先に更新してください。</Text>
      {isOwner && manager ? <SettingsAction title="共有グループを互換更新" intent="primary" disabled={busy} onPress={() => Alert.alert('共有グループを更新しますか？',
        '全メンバーのアプリ更新後に進めてください。旧版のアプリは更新後のグループを同期できません。保存済みデータは保持します。',
        [{ text: 'キャンセル', style: 'cancel' }, { text: '更新する', onPress: () => void run(async () => { await manager.upgradeScheduler(); await refresh(); }) }])} /> : null}
    </Card> : null}
    {isOwner && workspace.session.recovery.enabled ? <View style={{ gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 14 }}><V2RecoveryPanel embedded groupId={workspace.groupId} recovery={workspace.session.recovery}
      isOwner={isOwner} busy={busy} run={run} devices={roster?.body.members.flatMap(member => member.devices.map(device => ({ deviceId: device.identity.deviceId,
        displayName: snapshot?.members.find(item => item.id === member.userId)?.displayName ?? 'メンバー' }))) ?? []} /></View> : null}
    </> : null}
    </SettingsGroup> : null}
    {snapshot?.recoverySummary?.heldChanges ? <Text accessibilityRole="alert" style={styles.error}>確認待ちの変更が{snapshot.recoverySummary.heldChanges}件あります。「同期・復旧」で確認してください。</Text> : null}
    {!section ? <View style={styles.exit}>
      {record.status === 'joining' && record.join ? <SettingsAction title={joinEnded ? '別の招待で参加' : '参加申請を取り消す'} intent={joinEnded ? 'primary' : 'destructive'} disabled={busy} onPress={() => void run(async () => {
        await workspace.cancelJoinRequest(); await context.refreshSharing(); router.replace('/sharing');
      })} /> : manager ? <SettingsAction title="グループから退出" compact intent="destructive" disabled={busy || ['left', 'removed'].includes(record.status)}
        onPress={() => Alert.alert('グループから退出しますか？', detail.pending ? `未送信の変更が${detail.pending}件あります。退出後は送信できません。端末内の記録は保持します。` : '共有データの取得と送信を終了します。',
          [{ text: 'キャンセル', style: 'cancel' }, { text: '退出する', style: 'destructive', onPress: () => void run(async () => { await manager.leave(); await context.refreshSharing(); router.replace('/sharing'); }) }])} /> : null}
    </View> : null}
  </>;
}

function userMessage(error: unknown): string {
  return error instanceof Error && /[ぁ-んァ-ヶ一-龯]/u.test(error.message) ? error.message : sharingFailureMessage(error);
}
const styles = StyleSheet.create({
  settingsPage: { paddingTop: 14 },
  entryPage: { paddingTop: 16, gap: 20 }, entryIntro: { gap: 6 }, entryForm: { gap: 12 },
  invitationRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  invitationText: { flex: 1, minWidth: 0, gap: 2 },
  entryTabs: { alignItems: 'center' }, hiddenEntry: { display: 'none' },
  body: { ...typography.body, color: palette.ink }, label: { ...typography.subheading, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.label, color: palette.warning },
  input: { ...typography.body, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 12, color: palette.ink },
  multiline: { minHeight: 90, maxHeight: 160, textAlignVertical: 'top' }, buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  exit: { marginTop: 16 },
  member: { gap: 7, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  memberHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  memberName: { ...typography.body, color: palette.ink, fontWeight: '500', flex: 1, minWidth: 0 },
  candidate: { gap: 8, padding: 12, backgroundColor: palette.accentSoft, borderRadius: 12 },
  verification: { ...typography.section, fontWeight: '700', color: palette.ink, fontVariant: ['tabular-nums'], letterSpacing: 1.5 },
  qr: { width: '100%', maxWidth: 330, aspectRatio: 1, alignSelf: 'center', backgroundColor: '#FFFFFF' },
});
