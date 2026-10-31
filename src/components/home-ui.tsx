import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LoadOrder } from '../domain/scheduling/task-priority';
import { formatJapaneseDate } from '../domain/scheduling/local-date';
import type { LocalDate } from '../domain/shared/types';
import { palette, typography } from './planner-ui';
import { GroupIcon } from './group-icon';
import type { homeSummary } from '../features/planner/home-summary';
import type { HomeWeekScope } from '../features/planner/home-presentation';
import { recordHomeFirstLayout } from '../platform/diagnostics/startup-clock';

export function HomeWeekSwitcher({ scope, onChange }: { scope: HomeWeekScope; onChange: (scope: HomeWeekScope) => void }) {
  return <View style={styles.weekSwitcher}>{(['current', 'next'] as const).map(value => <Pressable key={value} accessibilityRole="button"
    accessibilityState={{ selected: scope === value }} onPress={() => onChange(value)} style={[styles.weekOption, scope === value && styles.weekSelected]}>
    <Text style={[styles.weekText, scope === value && styles.weekSelectedText]}>{value === 'current' ? '今週' : '来週'}</Text>
  </Pressable>)}</View>;
}
export function HomeUpcomingDate({ date }: { date: LocalDate }) {
  return <Text style={styles.upcomingDate}>{formatJapaneseDate(date, { weekday: true }).replace(/^\d+月/, '')}のおすすめ</Text>;
}

export function HomeHeader({ today, workspaceName, onGroup = () => router.push('/sharing') }: {
  today: LocalDate; workspaceName?: string; onGroup?: () => void;
}) {
  return <View style={styles.header} onLayout={recordHomeFirstLayout}>
    <View style={styles.identity}><Text style={styles.date}>{formatJapaneseDate(today, { year: true, weekday: true })}</Text>
      {workspaceName ? <Text numberOfLines={1} style={styles.workspace}>{workspaceName}</Text> : null}</View>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="ヘルプを開く" onPress={() => router.push('/help')} style={styles.iconButton}>
        <SymbolView name={{ ios: 'questionmark.circle', android: 'help_outline' }} size={23} tintColor={palette.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="グループを開く" onPress={onGroup} style={styles.iconButton}><GroupIcon /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="設定を開く" onPress={() => router.push('/settings')} style={styles.iconButton}>
        <SymbolView name={{ ios: 'gearshape', android: 'settings' }} size={23} tintColor={palette.muted} /></Pressable>
    </View>
  </View>;
}
export function HomeProgress({ summary, total, done }: { summary: ReturnType<typeof homeSummary>; total: number; done: number }) {
  if (!summary.showProgress) return null;
  return <View style={styles.progress}>
    <View style={styles.progressRow}>
      <Text style={styles.count}>{total}件中{done}件が完了しました</Text>{done > 0 ? <Text style={styles.count}>{summary.percent}%</Text> : null}</View>
      <View style={styles.track}><View style={[styles.fill, { width: `${summary.percent}%` }]} /></View>
  </View>;
}
export function LoadSortButton({ order, onPress }: { order: LoadOrder; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`負荷の並び順：${order === 'heavy' ? '重い順' : '軽い順'}`}
    accessibilityHint="期限間近と完了済みの位置を保って、重い順と軽い順を切り替えます" onPress={onPress} style={styles.sort}>
    <Text style={styles.sortText}>{order === 'heavy' ? '重い順' : '軽い順'}</Text>
    <SymbolView name={{ ios: 'arrow.up.arrow.down', android: 'swap_vert' }} size={17} tintColor={palette.muted} />
  </Pressable>;
}
export function CompletionToast({ onUndo, busy = false, message = '完了しました', accessibilityLabel = '直前の完了を元に戻す' }: { onUndo: () => void; busy?: boolean; message?: string; accessibilityLabel?: string }) {
  return <View style={styles.toast} accessibilityLiveRegion="polite">
    <Text style={styles.toastText}>{message}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={busy} onPress={onUndo} style={styles.undo}>
      <Text style={[styles.undoText, busy && styles.muted]}>元に戻す</Text></Pressable>
  </View>;
}
const styles = StyleSheet.create({
  weekSwitcher: { flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: palette.accentSoft, marginTop: 2 },
  weekOption: { flex: 1, minHeight: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }, weekSelected: { backgroundColor: palette.surface },
  weekText: { ...typography.caption, color: palette.muted, fontWeight: '600' }, weekSelectedText: { color: palette.accent, fontWeight: '800' },
  upcomingDate: { ...typography.caption, color: palette.muted, fontWeight: '600', marginTop: 8 },
  header: { flexDirection: 'row', gap: 6, alignItems: 'center' }, identity: { flex: 1, minWidth: 0, gap: 2 },
  date: { ...typography.caption, color: palette.muted }, workspace: { ...typography.label, color: palette.ink, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 2 }, iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  progress: { gap: 5, paddingVertical: 6 },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, count: { ...typography.caption, color: palette.muted },
  track: { height: 4, borderRadius: 2, backgroundColor: palette.accentSoft, overflow: 'hidden' }, fill: { height: '100%', borderRadius: 2, backgroundColor: palette.accent },
  sort: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 10, minHeight: 44 }, sortText: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  toast: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', maxWidth: '100%', flexShrink: 1, gap: 14, backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingLeft: 16, paddingRight: 6, marginHorizontal: 16, marginBottom: 8, shadowColor: '#1A2340', shadowOpacity: 0.08, shadowRadius: 7, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  toastText: { ...typography.caption, color: palette.ink, flexShrink: 1 }, undo: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }, undoText: { ...typography.label, fontWeight: '600', color: palette.accent }, muted: { color: palette.muted },
});
