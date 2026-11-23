import { router, usePreventRemove } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/components/screen-safe-area';
import { palette, typography } from '@/components/planner-ui';
import { SettingsHeader } from '@/components/settings-header';
import { SettingsSegments } from '@/components/settings-controls';
import { SettingsList, SettingsRow } from '@/features/settings/settings-navigation';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { finishStartupDisplay } from '@/platform/diagnostics/startup-splash';
import { HomeReview, homeReviewScenarios } from './home-review';
import { CalendarReview, calendarReviewScenarios } from './calendar-review';
import { ApplianceReview, applianceReviewScenarios } from './appliance-review';
import { FailureReview, failureReviewScenarios } from './failure-review';
import { ChoreReview, choreReviewScenarios } from './chore-review';
import { RhythmReview, SetupReview, rhythmReviewScenarios, setupReviewScenarios } from './setup-review';
import { GroupReview, groupReviewScenarios } from './group-review';
import { WasteReview, wasteReviewScenarios } from './waste-review';
import { uiReviewBuild } from './enabled';

const areas = [
  { id: 'home', label: 'ホーム', groups: [{ Review: HomeReview, cases: homeReviewScenarios }] },
  { id: 'calendar', label: 'カレンダー', groups: [{ Review: CalendarReview, cases: calendarReviewScenarios }] },
  { id: 'chores', label: '家事', groups: [{ Review: ChoreReview, cases: choreReviewScenarios }] },
  { id: 'appliances', label: '家電', groups: [{ Review: ApplianceReview, cases: applianceReviewScenarios }] },
  { id: 'settings', label: '設定・共有', groups: [
    { title: '初回設定', Review: SetupReview, cases: setupReviewScenarios },
    { title: '生活リズム', Review: RhythmReview, cases: rhythmReviewScenarios },
    { title: '共有グループ', Review: GroupReview, cases: groupReviewScenarios },
    { title: 'ゴミ収集日', Review: WasteReview, cases: wasteReviewScenarios },
  ] },
  { id: 'errors', label: 'エラー', groups: [{ Review: FailureReview, cases: failureReviewScenarios }] },
] as const;
type ReviewArea = typeof areas[number]['id'];
const controlRows = [areas.slice(0, 3), areas.slice(3)];

export default function UiReviewScreen({ initialArea, initialScenario }: { initialArea?: string; initialScenario?: string }) {
  const [area, setArea] = useState<ReviewArea>(() => areas.find(item => item.id === initialArea)?.id ?? 'home');
  const [scenario, setScenario] = useState(initialScenario);
  const { width, fontScale } = useWindowDimensions();
  const section = areas.find(item => item.id === area)!;
  const group = section.groups.find(group => group.cases.some(item => item.id === scenario));
  const selected = group?.cases.find(item => item.id === scenario);
  const title = selected && 'screenTitle' in selected ? selected.screenTitle : 'UI確認用データ';
  const closeScenario = () => setScenario(undefined);
  usePreventRemove(Boolean(selected), closeScenario);
  const back = () => {
    if (selected) closeScenario();
    else if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };
  return <SafeAreaView edges={['top', 'bottom']} style={styles.root} onLayout={finishStartupDisplay}>
    {!selected || area === 'errors' ? <View style={styles.header}><SettingsHeader title={title} onBack={back}
      backAccessibilityLabel={selected ? 'UI確認用データ一覧へ戻る' : undefined} hideBack={uiReviewBuild && !selected} /></View> : null}
    {selected && group
      ? <View style={styles.body}><WorkspaceContext.Provider value={null}>
          <SafeAreaProvider><group.Review key={`${area}:${selected.id}`} scenario={selected.id} onExit={closeScenario} /></SafeAreaProvider>
        </WorkspaceContext.Provider></View>
      : <View style={styles.body}>
          <View style={styles.control}>{(width - 32 >= 520 * fontScale ? [areas] : controlRows).map(row =>
            <SettingsSegments<ReviewArea> key={row[0].id} value={area} options={row} onValueChange={setArea} tone="quiet" fullWidth />)}</View>
          <ScrollView key={area} contentContainerStyle={styles.cases}>
            {section.groups.map(entries => {
              const rows = <SettingsList>{entries.cases.map(item => <SettingsRow key={item.id} title={item.label} onPress={() => setScenario(item.id)} />)}</SettingsList>;
              return 'title' in entries ? <View key={entries.title} style={styles.caseGroup}>
                <Text accessibilityRole="header" style={styles.caseHeading}>{entries.title}</Text>{rows}
              </View> : rows;
            })}
          </ScrollView>
        </View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  header: { paddingHorizontal: 12 },
  body: { flex: 1, minHeight: 0 },
  control: { gap: 6, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  cases: { gap: 14, paddingHorizontal: 16, paddingBottom: 12 },
  caseGroup: { gap: 5 },
  caseHeading: { ...typography.label, color: palette.ink, fontWeight: '600' },
});
