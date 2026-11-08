import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Share, Text } from 'react-native';
import { AppButton, Card, Page, typography } from '../../components/planner-ui';
import { useWorkspace } from '../../hooks/use-workspace';
import { PrivateCalendarDeviceScreen } from '../../features/sharing/private-calendar/device-screen';
import { openPrivateCalendarDevices } from '../../platform/sharing/private-calendar-devices';

export default function PrivateCalendarDevicesRoute() {
  const { userId, ready } = useWorkspace(); const router = useRouter();
  const loadSession = useCallback(async () => { if (!userId) throw new Error('本人用アカウントを確認してください。'); return openPrivateCalendarDevices(userId); }, [userId]);
  if (!ready || !userId) return <Page><Card><Text style={typography.body}>共有用アカウントでログインして、本人の端末を管理できます。</Text><AppButton title="共有用アカウントへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  return <PrivateCalendarDeviceScreen key={userId} loadSession={loadSession} onBack={() => router.canGoBack() ? router.back() : router.replace('/sharing')}
    onShare={async value => { await Share.share({ message: typeof value === 'string' ? value : JSON.stringify(value) }); }} />;
}
