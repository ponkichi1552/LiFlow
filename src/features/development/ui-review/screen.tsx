import { router, usePreventRemove } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { palette } from '@/components/planner-ui';
import { SettingsHeader } from '@/components/settings-header';
import { SettingsSegments } from '@/components/settings-controls';
import { SettingsList, SettingsRow } from '@/features/settings/settings-navigation';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { finishStartupDisplay } from '@/platform/diagnostics/startup-splash';
import { HomeReview, homeReviewScenarios } from './home-review';
import { CalendarReview, calendarReviewScenarios } from './calendar-review';
import { ApplianceReview, applianceReviewScenarios } from './appliance-review';
import { FailureReview, failureReviewScenarios } from './failure-review';
import { uiReviewBuild } from './enabled';

const areas = [
  { id: 'home', label: 'ホーム', Review: HomeReview, cases: homeReviewScenarios },
  { id: 'calendar', label: 'カレンダー', Review: CalendarReview, cases: calendarReviewScenarios },
  { id: 'appliances', label: '家電', Review: ApplianceReview, cases: applianceReviewScenarios },
  { id: 'errors', label: 'エラー', Review: FailureReview, cases: failureReviewScenarios },
] as const;
type ReviewArea = typeof areas[number]['id'];

export default function UiReviewScreen({ initialArea, initialScenario }: { initialArea?: string; initialScenario?: string }) {
  const [area, setArea] = useState<ReviewArea>(() => areas.find(item => item.id === initialArea)?.id ?? 'home');
  const [scenario, setScenario] = useState(initialScenario);
  const section = areas.find(item => item.id === area)!;
  const selected = section.cases.find(item => item.id === scenario);
  const closeScenario = () => setScenario(undefined);
  usePreventRemove(Boolean(selected), closeScenario);
  const back = () => {
    if (selected) closeScenario();
    else if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };
  return <SafeAreaView edges={['top', 'bottom']} style={styles.root} onLayout={finishStartupDisplay}>
    <View style={styles.header}><SettingsHeader title={selected?.label ?? 'UI確認用データ'} onBack={back}
      backAccessibilityLabel={selected ? 'UI確認用データ一覧へ戻る' : undefined} hideBack={uiReviewBuild && !selected} /></View>
    {selected
      ? <View style={styles.body}><WorkspaceContext.Provider value={null}>
          <section.Review key={`${area}:${selected.id}`} scenario={selected.id} />
        </WorkspaceContext.Provider></View>
      : <View style={styles.body}>
          <View style={styles.control}><SettingsSegments<ReviewArea> value={area} options={areas} onValueChange={setArea} tone="quiet" fitContent /></View>
          <ScrollView contentContainerStyle={styles.cases}>
            <SettingsList>{section.cases.map(item => <SettingsRow key={item.id} title={item.label} onPress={() => setScenario(item.id)} />)}</SettingsList>
          </ScrollView>
        </View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  header: { paddingHorizontal: 12 },
  body: { flex: 1, minHeight: 0 },
  control: { alignItems: 'flex-start', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  cases: { paddingHorizontal: 16, paddingBottom: 12 },
});
