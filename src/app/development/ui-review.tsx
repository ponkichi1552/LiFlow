import { router, useLocalSearchParams } from 'expo-router';
import { lazy, Suspense } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { Page, palette, typography } from '@/components/planner-ui';
import { SettingsHeader } from '@/components/settings-header';
import { uiReviewEnabled } from '@/features/development/ui-review/enabled';

const UiReviewScreen = lazy(() => import('@/features/development/ui-review/screen'));

export default function UiReviewRoute() {
  const params = useLocalSearchParams<{ area?: string; scenario?: string }>();
  const header = <SettingsHeader title="UI確認用データ" onBack={() => router.back()} />;
  if (!uiReviewEnabled) return <Page header={header}><Text style={{ ...typography.body, color: palette.muted }}>開発ビルド専用です。</Text></Page>;
  return <Suspense fallback={<Page header={header}><ActivityIndicator accessibilityLabel="確認用データを読み込み中" color={palette.accent} /></Page>}>
    <UiReviewScreen initialArea={typeof params.area === 'string' ? params.area : undefined} initialScenario={typeof params.scenario === 'string' ? params.scenario : undefined} />
  </Suspense>;
}
