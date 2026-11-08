import { router } from 'expo-router';
import { useLinkingURL } from 'expo-linking';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { AppButton, Page, palette, typography } from '@/components/planner-ui';
import { parseSharedInvitation } from '@/features/sharing/invitations';
import { requestSharingWorkspace, enableSharingSession, sharingFailureMessage, sharingSessionUser } from '@/platform/sharing/workspaces';
import { signInSharingWithGoogle } from '@/platform/sharing/auth';
import { useWorkspace } from '@/hooks/use-workspace';
import { SettingsHeader } from '@/features/settings/settings-navigation';

const isInvitationURL = (value: string | null): value is string => Boolean(value?.startsWith('houseworkplanner://sharing/join'));

/** Fragment secrets are consumed locally and never copied into Router query parameters. */
export default function SharingJoinScreen() {
  const url = useLinkingURL(); const workspace = useWorkspace();
  // An authentication callback can replace Linking's latest URL. Keep the invitation locally.
  const [invitationURL, setInvitationURL] = useState(() => isInvitationURL(url) ? url : null);
  const [openedAt] = useState(() => Date.now());
  if (isInvitationURL(url) && url !== invitationURL) setInvitationURL(url);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false); const inFlight = useRef<{ url: string } | null>(null);
  const attempted = useRef<string | null>(null); const context = useRef(workspace); const target = useRef(invitationURL);
  const alive = useRef(true);
  useLayoutEffect(() => { context.current = workspace; target.current = invitationURL; }, [workspace, invitationURL]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Display validation is stable; the async operation checks the actual clock before login and submission.
  const groupId = useMemo(() => { try { return invitationURL ? parseSharedInvitation(invitationURL, openedAt).invitation.body.groupId : null; } catch { return null; } }, [invitationURL, openedAt]);
  const blocked = Boolean(groupId && workspace.group && ['active', 'creating', 'joining'].includes(workspace.group.status) && workspace.group.groupId !== groupId);
  const join = useCallback(async (link: string) => {
    if (!alive.current || inFlight.current || !context.current.ready) return;
    const operation = { url: link }; inFlight.current = operation; setBusy(true); setFailure(null);
    const initialOwner = context.current.userId;
    const ownsScreen = () => alive.current && inFlight.current === operation && target.current === link;
    const current = async (owner: string) => {
      if (!ownsScreen()) return false;
      const user = await sharingSessionUser();
      if (!ownsScreen()) return false;
      if (user?.uid !== owner) throw new Error('ログイン中のアカウントが変わりました。もう一度お試しください。');
      return true;
    };
    try {
      const destination = parseSharedInvitation(link, Date.now()).invitation.body.groupId;
      await enableSharingSession();
      if (!ownsScreen()) return;
      const user = await sharingSessionUser();
      if (!ownsScreen()) return;
      if (initialOwner && user?.uid !== initialOwner) throw new Error('ログイン中のアカウントが変わりました。もう一度お試しください。');
      const owner = user?.uid ?? (await signInSharingWithGoogle()).uid;
      if (!await current(owner)) return;
      // Consent can outlive the invitation. Never submit a link that expired during login.
      parseSharedInvitation(link, Date.now());
      const existing = context.current.group;
      if (existing && existing.userId === owner && ['active', 'creating', 'joining'].includes(existing.status)) {
        if (existing.groupId !== destination) throw new Error('現在のグループから退出するか、参加申請を取り消してから参加してください。');
        router.replace({ pathname: '/sharing/group/[groupId]', params: { groupId: existing.groupId } }); return;
      }
      const group = await requestSharingWorkspace(link);
      if (!await current(owner)) return;
      await context.current.refreshSharing();
      if (!await current(owner)) return;
      router.replace({ pathname: '/sharing/group/[groupId]', params: { groupId: group.groupId } });
    } catch (cause) { if (ownsScreen()) setFailure({ url: link, message: cause instanceof Error && /[ぁ-んァ-ヶ一-龯]/u.test(cause.message) ? cause.message : sharingFailureMessage(cause) }); }
    finally { if (inFlight.current === operation) inFlight.current = null; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (!workspace.ready || !invitationURL || !groupId || blocked || busy || attempted.current === invitationURL) return;
    attempted.current = invitationURL; void join(invitationURL);
  }, [workspace.ready, invitationURL, groupId, blocked, busy, join]);
  const message = failure?.url === invitationURL ? failure.message : null;
  return <Page header={<SettingsHeader title="グループに参加" onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />}>
    {blocked ? <Text style={typography.body}>参加できるグループは一つです。現在のグループから退出するか、申請を取り消してから参加してください。</Text>
      : !groupId ? <Text accessibilityRole="alert" style={typography.body}>招待リンクが無効、または期限が切れています。管理者から新しいリンクを受け取ってください。</Text>
      : message ? <><Text accessibilityRole="alert" style={[typography.body, { color: palette.warning }]}>{message}</Text>
        <AppButton title="再試行" disabled={busy} onPress={() => { if (invitationURL) void join(invitationURL); }} /></>
      : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><ActivityIndicator color={palette.accent} /><Text style={typography.body}>参加を申請しています…</Text></View>}
    {!busy ? <AppButton title="グループ画面へ" compact variant="quiet" onPress={() => router.replace('/sharing')} /> : null}
  </Page>;
}
