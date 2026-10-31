import { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { AppButton, BackButton, Card, Page, ScreenHeading, typography } from '@/components/planner-ui';

/** A stable Native entry for device tests. Release builds never show controls or open a QA context. */
export default function DevelopmentChecks() {
  const [host, setHost] = useState(''); const [run, setRun] = useState('phase6-v38-a1'); const [role, setRole] = useState<'owner' | 'member'>('owner');
  if (!__DEV__) return <Text>この画面は開発ビルド専用です。</Text>;
  return <Page header={<BackButton onPress={() => router.back()} />}><ScreenHeading title="開発検査" />
    <Card><Text style={typography.caption}>検査用データだけを使う開発ビルドの入口です。</Text>
      <TextInput accessibilityLabel="Emulator host" placeholder="ローカルEmulatorのIP" value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} style={typography.body} />
      <TextInput accessibilityLabel="検査名" value={run} onChangeText={setRun} autoCapitalize="none" autoCorrect={false} style={typography.body} />
      <AppButton title={role === 'owner' ? '所有者を選択中' : '所有者に切り替える'} onPress={() => setRole('owner')} compact variant="secondary" />
      <AppButton title={role === 'member' ? '参加者を選択中' : '参加者に切り替える'} onPress={() => setRole('member')} compact variant="secondary" />
      <AppButton title="異種OSの同一グループを検査" onPress={() => router.push({ pathname: '/development/v2-native-pair', params: { host, port: '8186', run, role } })} />
    </Card>
    <AppButton title="Google Tasks検査" onPress={() => router.push('/development/v2-google-tasks-preview')} variant="secondary" />
    <AppButton title="個人設定コピー検査" onPress={() => router.push('/development/v2-personal-copy-preview')} variant="secondary" />
    <AppButton title="完了通知検査" onPress={() => router.push('/development/v2-completion-notice-preview')} variant="secondary" />
  </Page>;
}
