import { useLayoutEffect, useRef, type ComponentRef, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import { choreOccurrenceName } from '../domain/chores/occurrence-name';
import { palette, typography } from '@/components/planner-ui';
import { GroupIcon, PersonIcon } from './group-icon';
import { Chevron } from './chevron';
import { formatJapaneseDate } from '../domain/scheduling/local-date';
import type { LocalDate } from '../domain/shared/types';
import { usePlannerBorderStyles } from './use-planner-border-styles';
import { plannerColorsForScheme } from './planner-theme';

export function TaskCheckboxRow({ chore, completed = false, deemphasized = false, source, urgent = false, overdue = false,
  onToggle, onOpen, onChangeDate, home = false, immediateCheckbox = false, compact = false, narrowCalendar, provisional = false, mixedSources = false, detail, detailsExpanded, lastInList = false, contextLabel, action, footer, executionWindow, seasonalWork, calendarTimeLabel, homeSourceLabel }: {
  chore: ChoreDefinition; completed?: boolean; deemphasized?: boolean; source?: 'personal' | 'shared' | 'instructed';
  urgent?: boolean; overdue?: boolean; onToggle?: () => boolean | void | Promise<void>; onOpen: () => void; onChangeDate?: () => void; home?: boolean; immediateCheckbox?: boolean; compact?: boolean; provisional?: boolean; mixedSources?: boolean;
  executionWindow?: { start: LocalDate; end: LocalDate };
  seasonalWork?: ChoreScheduleEntry['seasonalWork'];
  detail?: string; detailsExpanded?: boolean; lastInList?: boolean; contextLabel?: string; action?: ReactNode; footer?: ReactNode;
  calendarTimeLabel?: string; narrowCalendar?: 'three' | 'week'; homeSourceLabel?: '個人' | '共有';
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const colors = plannerColorsForScheme(useColorScheme());
  const animateCheckDirectly = home && immediateCheckbox && Platform.OS === 'android';
  const checkedLayer = useRef<ComponentRef<typeof View>>(null);
  const earlyCheck = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    // The accepted queue remains the source of truth, including save failures,
    // rapid toggles and the verified replacement of a cached home.
    if (earlyCheck.current !== null && earlyCheck.current !== completed) {
      checkedLayer.current?.setNativeProps({ style: { opacity: completed ? 1 : 0 } });
    }
    earlyCheck.current = null;
  });
  const toggle = animateCheckDirectly && onToggle ? () => {
    if (onToggle() !== true || !checkedLayer.current) return;
    earlyCheck.current = !completed;
    checkedLayer.current.setNativeProps({ style: { opacity: completed ? 0 : 1 } });
  } : onToggle;
  const name = choreOccurrenceName(chore.name, seasonalWork);
  const qualifier = homeSourceLabel && contextLabel ? `${homeSourceLabel}・${contextLabel}` : homeSourceLabel ?? contextLabel;
  const actionName = qualifier ? `${name}（${qualifier}）` : name;
  const minutes = Number.isFinite(chore.estimatedMinutes) && chore.estimatedMinutes! > 0 ? `約${chore.estimatedMinutes}分` : '';
  const period = executionWindow && executionWindow.start !== executionWindow.end
    ? `${formatJapaneseDate(executionWindow.start)}〜${formatJapaneseDate(executionWindow.end)}` : undefined;
  const nearDeadline = urgent && !completed;
  const deadline = home && (overdue || nearDeadline) && !completed && executionWindow && !period
    ? overdue ? `期限 ${formatJapaneseDate(executionWindow.end)}` : `${formatJapaneseDate(executionWindow.end)}まで`
    : undefined;
  const sourceLabel = source === 'shared' || source === 'instructed' ? '共有の家事' : source === 'personal' && mixedSources ? '個人の家事' : undefined;
  const homeTiming = executionWindow && period ? calendarPeriodLabel(executionWindow.start, executionWindow.end) : deadline ?? (nearDeadline ? '期限間近' : '');
  const homeMetadata = [minutes, homeTiming, detail]
    .filter(Boolean).join(' · ');
  const checkbox = <Pressable accessibilityRole="checkbox" accessibilityLabel={`${actionName}を${completed ? '未完了に戻す' : '完了'}`}
    accessibilityHint={mixedSources && !homeSourceLabel ? sourceLabel : undefined}
    accessibilityState={{ checked: completed, disabled: !onToggle }} disabled={!onToggle} onPress={toggle} hitSlop={8}
    style={[styles.checkbox, !animateCheckDirectly && completed && styles.checkboxCompleted]}>
    {animateCheckDirectly ?
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" ref={checkedLayer}
        style={[styles.checkbox, styles.checkboxLayer, styles.checkboxCompleted, { opacity: completed ? 1 : 0 }]}>
        <Text style={styles.checkmark}>✓</Text>
      </View>
    : completed ? <Text style={styles.checkmark}>✓</Text> : null}
  </Pressable>;
  const narrowWeek = narrowCalendar === 'week';
  const compactPeriod = executionWindow && period ? calendarPeriodLabel(executionWindow.start, executionWindow.end) : '';
  const compactDetail = [provisional ? '仮' : '', compactPeriod, calendarTimeLabel].filter(Boolean).join(' · ');
  const compactValue = [completed ? '完了済み' : '', compactDetail].filter(Boolean).join('、');
  const showCompactDetail = !narrowCalendar && Boolean(compactDetail);
  if (compact) return <View style={styles.compactRow}><View style={styles.compactPrimary}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${actionName}の${onChangeDate ? '今回の日付を変更' : '説明を開く'}`} accessibilityValue={compactValue ? { text: compactValue } : undefined} accessibilityHint={[sourceLabel, onChangeDate ? '今回の実施日を選択します' : '手順や道具を確認します'].filter(Boolean).join('。')} onPress={onChangeDate ?? onOpen}
      style={({ pressed }) => [styles.compactOpen, narrowCalendar && styles.narrowCalendarOpen, narrowWeek && styles.narrowWeekOpen, pressed && styles.pressed]}>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={[styles.compactAction, narrowWeek && styles.narrowAction]}>
        <SymbolView name={onChangeDate ? { ios: 'calendar', android: 'calendar_month' } : { ios: 'chevron.right', android: 'chevron_right' }}
          size={narrowWeek ? 10 : narrowCalendar ? 12 : 15} tintColor={colors.accent} />
      </View>
      <View style={styles.compactCopy}><Text numberOfLines={narrowCalendar || showCompactDetail ? 1 : 2} ellipsizeMode="tail"
        lineBreakStrategyIOS="standard" textBreakStrategy="highQuality"
        style={[styles.compactName, narrowCalendar && styles.narrowCalendarName, completed && styles.completedText]}>{name}</Text>
        {showCompactDetail ? <Text numberOfLines={1} ellipsizeMode="tail" style={styles.compactPeriod}>{compactDetail}</Text> : null}
      </View>
    </Pressable></View>
  </View>;
  return <View style={[styles.row, !home && source && source !== 'personal' && styles.sharedRow, !home && source === 'instructed' && styles.instructedRow,
    deemphasized && !completed && !home && styles.deemphasizedRow, urgent && !completed && styles.urgentRow,
    home && styles.listRow, home && lastInList && styles.lastRow]}>
    {/* Siblings keep the full row opener and checkbox as independent accessible actions. */}
    <Pressable accessibilityRole="button" accessibilityLabel={`${actionName}の説明を開く`}
      accessibilityHint={[source === 'shared' || source === 'instructed' ? '共有の家事です' : source === 'personal' && mixedSources ? '個人の家事です' : '', minutes, period ? `実施期間は${period}です` : deadline, home && nearDeadline ? '期限間近' : '', home && detail, '手順や道具を確認します'].filter(Boolean).join('。')}
      accessibilityState={detailsExpanded === undefined ? undefined : { expanded: detailsExpanded }} onPress={onOpen}
      style={({ pressed }) => [StyleSheet.absoluteFill, styles.openArea, home && styles.listOpenArea, pressed && styles.pressed]} />
    <View pointerEvents="box-none" style={[styles.content, home && styles.listContent]}>
    {home ? checkbox : null}
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.copy}>
      <Text style={[styles.name, deemphasized && !completed && styles.deemphasizedText, completed && styles.completedText]}>{name}</Text>
      {home ? homeMetadata || mixedSources && sourceLabel ? <View style={styles.metadata}>
        {mixedSources && sourceLabel ? <View testID={`chore-source-${source === 'personal' ? 'personal' : 'shared'}`} style={styles.sourceIcon}>
          {source === 'personal' ? <PersonIcon size={16} /> : <GroupIcon size={18} />}
        </View> : null}
        {homeMetadata ? <Text style={[styles.category, urgent && !completed && styles.urgentText, completed && styles.completedCategory]}>{homeMetadata}</Text> : null}
      </View> : null : source || urgent || chore.category || period ? <View style={styles.metadata}><Text style={[styles.category, completed && styles.completedCategory]}>{[
        source === 'instructed' ? '共有・日時指定' : source === 'shared' ? '共有' : source === 'personal' && mixedSources ? '個人' : '',
        urgent && !completed ? '期限間近' : '', chore.category, period,
      ].filter(Boolean).join(' · ')}</Text></View> : null}
    </View>
    {action ? <View style={styles.action}>{action}</View> : null}
    <View pointerEvents="none"><Chevron direction={detailsExpanded === undefined ? 'right' : detailsExpanded ? 'up' : 'down'} /></View>
    {!home ? checkbox : null}
    </View>
    {footer ? <View style={home ? styles.listFooter : undefined}>{footer}</View> : null}
  </View>;
}
export function calendarPeriodLabel(start: LocalDate, end: LocalDate) {
  const date = (value: LocalDate) => value.slice(0, 4) !== start.slice(0, 4) || start.slice(0, 4) !== end.slice(0, 4)
    ? value.split('-').map(Number).join('/') : value.slice(5).split('-').map(Number).join('/');
  return `${date(start)}–${date(end)}`;
}
const baseStyles = StyleSheet.create({
  compactRow: { minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  compactPrimary: { flexDirection: 'row', alignItems: 'center' },
  compactAction: { width: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  narrowAction: { width: 10 },
  compactOpen: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingVertical: 3, paddingHorizontal: 6, gap: 6 },
  compactCopy: { flex: 1, minWidth: 0 },
  compactName: { ...typography.label, color: palette.ink, fontWeight: '500' },
  narrowCalendarOpen: { paddingLeft: 3, paddingRight: 3, gap: 3 },
  narrowWeekOpen: { gap: 2 },
  narrowCalendarName: { ...typography.small, color: palette.ink, fontWeight: '600' },
  compactPeriod: { ...typography.small, color: palette.muted },
  row: { minHeight: 64, gap: 6, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 9 },
  listRow: { minHeight: 56, paddingVertical: 5, borderRadius: 0, borderWidth: 0, borderLeftWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border }, lastRow: { borderBottomWidth: 0 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 14 }, listContent: { gap: 12 }, listFooter: { paddingLeft: 40 }, action: { minWidth: 44 },
  openArea: { borderRadius: 13, margin: 1 }, listOpenArea: { borderRadius: 0 }, pressed: { backgroundColor: palette.accentSoft },
  sharedRow: { borderLeftWidth: 3, borderLeftColor: palette.shared }, instructedRow: { borderLeftColor: palette.sharedStrong, backgroundColor: palette.sharedSoft },
  urgentRow: { borderLeftWidth: 3, borderLeftColor: palette.gold }, urgentText: { color: palette.gold },
  deemphasizedRow: { backgroundColor: palette.elevated, borderColor: palette.border },
  copy: { flex: 1, minWidth: 0, gap: 2, minHeight: 44, justifyContent: 'center' }, metadata: { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
  sourceIcon: { minHeight: typography.caption.lineHeight, justifyContent: 'center', flexShrink: 0 },
  name: { ...typography.subheading, color: palette.ink, fontWeight: '600' }, category: { ...typography.caption, color: palette.muted, flexShrink: 1 },
  deemphasizedText: { color: palette.muted }, completedText: { color: palette.muted, textDecorationLine: 'line-through' }, completedCategory: { color: palette.muted },
  checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: palette.inputBorder, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  checkboxLayer: { position: 'absolute' },
  checkboxCompleted: { borderColor: palette.accent, backgroundColor: palette.accent }, checkmark: { color: palette.accentInk, fontSize: 16, fontWeight: '800', lineHeight: 20 },
});
