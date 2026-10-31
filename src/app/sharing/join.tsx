import { router } from 'expo-router';
import { useLinkingURL } from 'expo-linking';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, typography } from '@/components/planner-ui';
import { parseSharedInvitation } from '@/features/sharing/invitations';
import { requestSharingWorkspace, enableSharingSession, sharingFailureMessage } from '@/platform/sharing/workspaces';
import { signInSharingWithGoogle } from '@/platform/sharing/auth';
import { useWorkspace } from '@/hooks/use-workspace';

/** Fragment secrets are consumed locally and never copied into Router query parameters. */
export default function SharingJoinScreen() {
  const url = useLinkingURL(); const workspace = useWorkspace(); const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const [openedAt] = useState(() => Date.now());
  const valid = useMemo(() => { try { if (!url) return null; return parseSharedInvitation(url, openedAt).invitation.body.groupId; } catch { return null; } }, [openedAt, url]);
  const blocked = workspace.group && workspace.group.groupId !== valid;
  const join = async () => {
    if (!url || inFlight.current) return; inFlight.current = true; setBusy(true); setMessage(null);
    try {
      await enableSharingSession(); if (!workspace.userId) await signInSharingWithGoogle();
      const group = await requestSharingWorkspace(url); await workspace.refreshSharing();
      router.replace({ pathname: '/sharing/group/[groupId]', params: { groupId: group.groupId } });
    } catch (cause) { setMessage(cause instanceof Error && /[ぁ-んァ-ヶ一-龯]/u.test(cause.message) ? cause.message : sharingFailureMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Page header={<BackButton onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />}>
    <ScreenHeading title="共有グループへの招待" description="参加を申請すると、所有者の端末で確認・承認されます。" />
    <Card><Text style={typography.body}>個人の家事や履歴はそのまま残り、同じ画面にグループの家事・予定が表示されます。</Text>
      <AppButton title={workspace.userId ? 'この招待から参加を申請' : 'Googleでログインして参加を申請'} disabled={!valid || Boolean(blocked) || busy} onPress={() => void join()} />
      <AppButton title="共有グループの画面を開く" variant="quiet" disabled={busy} onPress={() => router.replace('/sharing')} />
      {blocked ? <Text style={typography.body}>参加できるグループは一つです。現在のグループから退出するか、申請を取り消してから参加してください。</Text> : null}
      {!valid ? <Text style={typography.body}>招待リンクが無効、または期限が切れています。所有者から新しいリンクを受け取ってください。</Text> : null}
      {busy ? <ActivityIndicator /> : null}{message ? <Text accessibilityRole="alert" style={typography.body}>{message}</Text> : null}
    </Card></Page>;
}
