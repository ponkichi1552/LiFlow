import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { calendarWeekday, WEEKDAY_NAMES } from '../domain/calendar/recurrence';
import type { LoadOrder } from '../domain/scheduling/task-priority';
import { formatJapaneseDate } from '../domain/scheduling/local-date';
import type { LocalDate } from '../domain/shared/types';
import { ActionLabel, navigationHeaderMetrics, palette, typography } from './planner-ui';
import { GroupIcon } from './group-icon';
import { Chevron } from './chevron';
import type { homeSummary } from '../features/planner/home-summary';
import type { HomeWeekScope } from '../features/planner/home-presentation';
import { recordHomeFirstLayout } from '../platform/diagnostics/startup-clock';
import { useOwnBirthday } from '../features/calendar/use-local-calendar';
import { BirthdayCake } from './birthday-cake';
import { plannerPressColorsForScheme } from './planner-theme';
import { WasteTypeLabel } from './waste-type-icon';

export function homeHeaderContainerStyle(workspaceName?: string) {
  return [styles.headerFrame, !workspaceName && styles.singleLineHeaderFrame];
}

export function HomeWeekSwitcher({ scope, onChange }: { scope: HomeWeekScope; onChange: (scope: HomeWeekScope) => void }) {
  const pressColors = plannerPressColorsForScheme(useColorScheme());
  return <View style={styles.weekSwitcher}>{(['current', 'next'] as const).map(value => <Pressable key={value} accessibilityRole="button"
    accessibilityState={{ selected: scope === value }} onPress={() => onChange(value)} style={({ pressed }) => [styles.weekOption, scope === value && styles.weekSelected, pressed && { backgroundColor: pressColors.tinted }]}>
    <Text style={[styles.weekText, scope === value && styles.weekSelectedText]}>{value === 'current' ? '今週の残り' : '来週'}</Text>
  </Pressable>)}</View>;
}
export function HomeUpcomingDate({ date, today }: { date: LocalDate; today: LocalDate }) {
  const formatted = formatJapaneseDate(date, { weekday: true });
  return <Text style={styles.upcomingDate}>{date.slice(0, 7) === today.slice(0, 7) ? formatted.replace(/^\d+月/, '') : formatted}のおすすめ</Text>;
}

export function HomeExpiredHeading({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`期限を過ぎた家事（${count}件）を${expanded ? '閉じる' : '開く'}`}
    accessibilityState={{ expanded }} onPress={onToggle} style={({ pressed }) => [styles.expiredHeading, pressed && styles.pressed]}>
    <Text style={styles.expiredTitle}>期限を過ぎた家事（{count}件）</Text><Chevron direction={expanded ? 'up' : 'down'} />
  </Pressable>;
}

export function HomeHeader({ today, birthdayDate = today, workspaceName, onGroup = () => router.push('/sharing') }: {
  today: LocalDate; birthdayDate?: LocalDate; workspaceName?: string; onGroup?: () => void;
}) {
  const birthday = useOwnBirthday(birthdayDate);
  return <HomeHeaderContent today={today} birthday={birthday} workspaceName={workspaceName} onLayout={recordHomeFirstLayout}
    onHelp={() => router.push('/help')} onGroup={onGroup} onSettings={() => router.push('/settings')} />;
}
export function HomeHeaderContent({ today, birthday, workspaceName, onLayout, onHelp, onGroup, onSettings }: {
  today: LocalDate; birthday: boolean; workspaceName?: string; onLayout?: () => void;
  onHelp: () => void; onGroup: () => void; onSettings: () => void;
}) {
  const weekday = WEEKDAY_NAMES[calendarWeekday(today)];
  return <View onLayout={onLayout}><View style={styles.header}>
    <View style={styles.identity}><Text style={styles.date} accessibilityLabel={`${formatJapaneseDate(today, { year: true })}${weekday}曜日`}>{today.replaceAll('-', '/')}・{weekday}</Text>
      {workspaceName ? <Text numberOfLines={1} style={styles.workspace}>{workspaceName}</Text> : null}</View>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="ヘルプを開く" onPress={onHelp} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <SymbolView name={{ ios: 'questionmark.circle', android: 'help_outline' }} size={23} tintColor={palette.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="グループを開く" onPress={onGroup} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}><GroupIcon /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="設定を開く" onPress={onSettings} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <SymbolView name={{ ios: 'gearshape', android: 'settings' }} size={23} tintColor={palette.muted} /></Pressable>
    </View>
  </View>{birthday ? <View accessible accessibilityLabel="お誕生日おめでとう！" style={styles.birthdayGreeting}>
    <BirthdayCake />
    <Text style={styles.birthdayText}>お誕生日おめでとう！</Text>
  </View> : null}</View>;
}
/** The same compact destinations on both platforms and in either workspace. */
export function HomeLinks({ onHistory, onWaste }: { onHistory: () => void; onWaste?: () => void }) {
  return <View style={styles.links}>
    <Pressable accessibilityRole="button" accessibilityLabel="実施履歴を見る" onPress={onHistory} style={({ pressed }) => [styles.link, pressed && styles.pressed]}><ActionLabel label="実施履歴" style={styles.linkText} /></Pressable>
    {onWaste ? <Pressable accessibilityRole="button" accessibilityLabel="ゴミ収集日を管理" onPress={onWaste} style={({ pressed }) => [styles.link, pressed && styles.pressed]}><ActionLabel label="ゴミ収集日" style={styles.linkText} /></Pressable> : null}
  </View>;
}
export function HomeEmptyChores({ message, action }: { message?: string; action?: { title: string; onPress: () => void } }) {
  return <View style={styles.emptyChores}>
    {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
    {action ? <Pressable accessibilityRole="button" accessibilityLabel={action.title} onPress={action.onPress}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
      <ActionLabel label={action.title} style={styles.linkText} />
    </Pressable> : null}
  </View>;
}
export function HomeProgress({ summary, total, done }: { summary: ReturnType<typeof homeSummary>; total: number; done: number }) {
  if (!summary.showProgress) return null;
  return <View style={styles.progress}>
    <Text style={styles.count}>{total}件中{done}件が完了しました</Text>
      <View style={styles.track}><View style={[styles.fill, { width: `${summary.percent}%` }]} /></View>
  </View>;
}
export function HomeWasteLabels({ entries }: { entries: readonly { key: string; label: string; source?: 'personal' | 'shared' }[] }) {
  if (!entries.length) return null;
  const scopes = new Map<string, Set<string>>();
  for (const { label, source } of entries) {
    const set = scopes.get(label) ?? new Set();
    if (source) set.add(source);
    scopes.set(label, set);
  }
  return <View accessibilityLabel="今日のゴミ収集" style={styles.wasteLabels}>{entries.map(({ key, label, source }) => <View key={key} style={styles.wasteLabel}>
    <WasteTypeLabel label={label} compact={false} />
    {source && (scopes.get(label)?.size ?? 0) > 1 ? <Text style={styles.count}>{source === 'personal' ? '個人' : '共有'}</Text> : null}
  </View>)}</View>;
}
export function LoadSortButton({ order, onPress }: { order: LoadOrder; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`負荷の並び順：${order === 'heavy' ? '重い順' : '軽い順'}`}
    accessibilityHint="期限間近と完了済みの位置を保って、重い順と軽い順を切り替えます" onPress={onPress} style={({ pressed }) => [styles.sort, pressed && styles.pressed]}>
    <Text style={styles.sortText}>{order === 'heavy' ? '重い順' : '軽い順'}</Text>
    <SymbolView name={{ ios: 'arrow.up.arrow.down', android: 'swap_vert' }} size={17} tintColor={palette.muted} />
  </Pressable>;
}
export function CompletionToast({ onUndo, busy = false, message = '完了しました', accessibilityLabel = '直前の完了を元に戻す' }: { onUndo: () => void; busy?: boolean; message?: string; accessibilityLabel?: string }) {
  return <View style={styles.toast} accessibilityLiveRegion="polite">
    <Text style={styles.toastText}>{message}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={busy} onPress={onUndo} style={({ pressed }) => [styles.undo, pressed && !busy && styles.pressed]}>
      <Text style={[styles.undoText, busy && styles.muted]}>元に戻す</Text></Pressable>
  </View>;
}
const styles = StyleSheet.create({
  pressed: { backgroundColor: palette.accentSoft, borderRadius: 10 },
  links: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingTop: 4 },
  emptyChores: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12 },
  emptyMessage: { ...typography.body, color: palette.muted, flexShrink: 1 },
  link: { minHeight: 44, justifyContent: 'center', flexShrink: 1 },
  linkText: { ...typography.label, color: palette.accent, fontWeight: '600' },
  weekSwitcher: { flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: palette.accentSoft, marginTop: 2 },
  weekOption: { flex: 1, minHeight: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }, weekSelected: { backgroundColor: palette.surface },
  weekText: { ...typography.caption, color: palette.muted, fontWeight: '600' }, weekSelectedText: { color: palette.accent, fontWeight: '800' },
  upcomingDate: { ...typography.caption, color: palette.muted, fontWeight: '600', marginTop: 8 },
  headerFrame: { ...navigationHeaderMetrics, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  singleLineHeaderFrame: { minHeight: 0, paddingBottom: 0 },
  header: { flexDirection: 'row', gap: 6, alignItems: 'center' }, identity: { flex: 1, minWidth: 0, gap: 2 },
  date: { ...typography.subheading, color: palette.ink, fontWeight: '600' }, workspace: { ...typography.caption, color: palette.muted },
  birthdayGreeting: { flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, marginTop: 5, backgroundColor: palette.warningSoft },
  birthdayText: { ...typography.caption, color: palette.calendarToday, fontWeight: '600', flexShrink: 1 },
  expiredHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44, marginTop: 6 },
  expiredTitle: { ...typography.label, color: palette.muted, fontWeight: '600', flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 2 }, iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  progress: { gap: 5, paddingVertical: 6 },
  count: { ...typography.caption, color: palette.muted },
  wasteLabels: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 },
  wasteLabel: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  track: { height: 4, borderRadius: 2, backgroundColor: palette.accentSoft, overflow: 'hidden' }, fill: { height: '100%', borderRadius: 2, backgroundColor: palette.accent },
  sort: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 10, minHeight: 44 }, sortText: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  toast: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', maxWidth: '100%', flexShrink: 1, gap: 14, backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingLeft: 16, paddingRight: 6, marginHorizontal: 16, marginBottom: 8, shadowColor: '#1A2340', shadowOpacity: 0.08, shadowRadius: 7, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  toastText: { ...typography.caption, color: palette.ink, flexShrink: 1 }, undo: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }, undoText: { ...typography.label, fontWeight: '600', color: palette.accent }, muted: { color: palette.muted },
});
