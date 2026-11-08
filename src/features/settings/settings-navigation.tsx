import { useContext, useState, type ReactNode } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Page, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { useAppAppearance } from '../../hooks/use-app-appearance';
import { DataCredits } from '../../components/data-credits';
import { ChoreSettingsSources, ChoreSettingsSourcePicker, useChoreSettingsGroup, type ChoreSettingsSource } from './chore-settings-sources';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { SettingsHeader } from '../../components/settings-header';
import { SettingsGroup, SettingsSegments } from '../../components/settings-controls';

export { SettingsHeader } from '../../components/settings-header';

export const settingsTitles = {
  chores: '家事ごとの設定', rhythm: '生活リズム', account: 'アカウント・連携', tasks: 'Google Tasks', calendar: 'Googleカレンダー', general: '一般',
  appearance: '表示', notifications: '通知・ウィジェット', weather: '天気予報・洗濯', birthdays: '誕生日',
  credits: 'このアプリについて', diagnostics: 'バックグラウンド同期の実行記録',
} as const;
export type SettingsCategory = keyof typeof settingsTitles;
export function settingsCategory(value: unknown): SettingsCategory | undefined {
  return typeof value === 'string' && Object.hasOwn(settingsTitles, value) && (value !== 'diagnostics' || typeof __DEV__ !== 'undefined' && __DEV__)
    ? value as SettingsCategory : undefined;
}
export const openSettingsCategory = (section: SettingsCategory) => router.push({ pathname: '/settings', params: { section } });

export function SettingsList({ children }: { children: ReactNode }) { return <View style={styles.list}>{children}</View>; }
export function SettingsRow({ title, summary, onPress, disabled = false }: { title: string; summary?: string; onPress: () => void; disabled?: boolean }) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityValue={summary ? { text: summary } : undefined} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, { borderBottomColor: colors.border }, pressed && styles.pressed, disabled && { opacity: 0.5 }]}>
    <Text style={styles.rowTitle}>{title}</Text>{summary ? <Text style={styles.summary} numberOfLines={1}>{summary}</Text> : null}<Chevron color={colors.accent} />
  </Pressable>;
}
export function SettingsNavigationScreen({ section }: { section?: 'chores' | 'appearance' | 'credits' }) {
  const workspace = useContext(WorkspaceContext);
  if (section === 'chores') return <ChoreSettingsPage />;
  if (section === 'appearance') return <AppearanceSettings />;
  if (section === 'credits') return <Page header={<SettingsHeader title={settingsTitles.credits} />}><DataCredits inline /></Page>;
  const group = workspace?.group;
  const groupDestination = group && group.userId === workspace?.userId && ['active', 'creating', 'joining'].includes(group.status)
    ? { pathname: '/sharing/group/[groupId]' as const, params: { groupId: group.groupId } } : '/sharing' as const;
  return <Page header={<SettingsHeader title="設定" appearance />} contentStyle={styles.page}>
    <SettingsList>
      <SettingsRow title={settingsTitles.chores} onPress={() => openSettingsCategory('chores')} />
      <SettingsRow title={settingsTitles.rhythm} onPress={() => openSettingsCategory('rhythm')} />
      <SettingsRow title="ゴミ収集日" onPress={() => router.push(workspace?.active?.protocol === 2 ? '/group-v2/waste' : '/waste')} />
      <SettingsRow title="共有グループ" onPress={() => router.push(groupDestination)} />
      <SettingsRow title={settingsTitles.account} onPress={() => openSettingsCategory('account')} />
      <SettingsRow title={settingsTitles.general} onPress={() => openSettingsCategory('general')} />
    </SettingsList>
  </Page>;
}
function ChoreSettingsPage() {
  const group = useChoreSettingsGroup();
  const scope = group ? `${group.userId}:${group.groupId}:${group.localGeneration ?? ''}` : 'personal';
  const [selection, setSelection] = useState<{ scope: string; source: ChoreSettingsSource }>({ scope, source: 'personal' });
  const source = group && selection.scope === scope ? selection.source : 'personal';
  return <Page header={<View style={{ gap: 4 }}><SettingsHeader title={settingsTitles.chores} />
    {group ? <ChoreSettingsSourcePicker value={source} onChange={next => setSelection({ scope, source: next })} /> : null}</View>} contentStyle={{ paddingTop: 10 }}>
    <ChoreSettingsSources key={scope} source={source} />
  </Page>;
}
function AppearanceSettings() {
  return <Page header={<SettingsHeader title="表示" />} contentStyle={styles.page}><AppearanceControls /></Page>;
}
export function AppearanceControls({ embedded = false }: { embedded?: boolean }) {
  const colors = plannerColorsForScheme(useColorScheme());
  const appearance = useAppAppearance(); const [error, setError] = useState<string | null>(null);
  const select = (value: 'system' | 'light' | 'dark') => { try { appearance.set(value); setError(null); } catch { setError('表示設定を保存できませんでした。'); } };
  return <View style={{ gap: 8 }}>{embedded ? <SettingsSegments fullWidth value={appearance.preference}
    options={[{ id: 'system', label: '自動' }, { id: 'light', label: 'ライト' }, { id: 'dark', label: 'ダーク' }]} onValueChange={select} /> : <SettingsList>
    {([{ value: 'system', title: '端末に合わせる' }, { value: 'light', title: 'ライト' }, { value: 'dark', title: 'ダーク' }] as const).map(option =>
      <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.title} accessibilityState={{ selected: appearance.preference === option.value }}
        onPress={() => select(option.value)}
        style={({ pressed }) => [styles.row, { borderBottomColor: colors.border }, pressed && styles.pressed]}><Text style={styles.rowTitle}>{option.title}</Text>
        {appearance.preference === option.value ? <Text style={styles.check} aria-hidden>✓</Text> : null}</Pressable>)}
  </SettingsList>}{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>;
}
export function SettingsSection({ section, id, children }: { section: SettingsCategory; id: SettingsCategory; children: ReactNode }) {
  if (section === 'general' && ['appearance', 'notifications', 'weather', 'birthdays', 'credits'].includes(id)) {
    return <SettingsGroup title={settingsTitles[id]} plain={id === 'appearance'}>{children}</SettingsGroup>;
  }
  return section === id ? <View style={styles.section}>{children}</View> : null;
}
const styles = StyleSheet.create({
  page: { paddingTop: 14, gap: 16 },
  list: { backgroundColor: palette.surface },
  row: { minHeight: 54, paddingHorizontal: 15, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  rowTitle: { ...typography.body, color: palette.ink, flex: 1 },
  summary: { ...typography.caption, color: palette.muted, flexShrink: 1, maxWidth: '45%' },
  section: { gap: 14 }, pressed: { backgroundColor: palette.accentSoft },
  check: { ...typography.body, color: palette.accent, fontWeight: '700' }, error: { ...typography.caption, color: palette.warning },
});
