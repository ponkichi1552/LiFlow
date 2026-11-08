import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import { choreOccurrenceName } from '../domain/chores/occurrence-name';
import { palette, typography } from '@/components/planner-ui';
import { GroupIcon, PersonIcon } from './group-icon';
import { Chevron } from './chevron';
import { formatJapaneseDate } from '../domain/scheduling/local-date';
import type { LocalDate } from '../domain/shared/types';
import { usePlannerBorderStyles } from './use-planner-border-styles';

export function TaskCheckboxRow({ chore, completed = false, deemphasized = false, source, urgent = false,
  onToggle, onOpen, home = false, compact = false, provisional = false, mixedSources = false, detail, detailsExpanded, lastInList = false, contextLabel, action, footer, sourceIcon, executionWindow, seasonalWork }: {
  chore: ChoreDefinition; completed?: boolean; deemphasized?: boolean; source?: 'personal' | 'shared' | 'instructed';
  urgent?: boolean; onToggle?: () => void; onOpen: () => void; home?: boolean; compact?: boolean; provisional?: boolean; mixedSources?: boolean;
  executionWindow?: { start: LocalDate; end: LocalDate };
  seasonalWork?: ChoreScheduleEntry['seasonalWork'];
  detail?: string; detailsExpanded?: boolean; lastInList?: boolean; contextLabel?: string; action?: ReactNode; footer?: ReactNode; sourceIcon?: 'person' | 'group';
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const name = choreOccurrenceName(chore.name, seasonalWork);
  const actionName = `${name}${contextLabel ? `（${contextLabel}）` : ''}`;
  const minutes = Number.isFinite(chore.estimatedMinutes) && chore.estimatedMinutes! > 0 ? `約${chore.estimatedMinutes}分` : '';
  const period = executionWindow && executionWindow.start !== executionWindow.end
    ? `${formatJapaneseDate(executionWindow.start)}〜${formatJapaneseDate(executionWindow.end)}` : undefined;
  const checkbox = <Pressable accessibilityRole="checkbox" accessibilityLabel={`${actionName}を${completed ? '未完了に戻す' : '完了'}`}
    accessibilityState={{ checked: completed, disabled: !onToggle }} disabled={!onToggle} onPress={onToggle} hitSlop={8}
    style={[styles.checkbox, completed && styles.checkboxCompleted]}>
    {completed ? <Text style={styles.checkmark}>✓</Text> : null}
  </Pressable>;
  if (compact) return <View style={[styles.compactRow, completed && styles.compactCompletedRow]}>
    <View style={styles.compactCheck}>{checkbox}</View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${actionName}の説明を開く`} accessibilityHint="手順や道具を確認します" onPress={onOpen}
      style={({ pressed }) => [styles.compactOpen, pressed && styles.pressed]}>
      <Text numberOfLines={2} style={[styles.compactName, completed && styles.completedText]}>{name}</Text>
      {provisional || executionWindow && executionWindow.start !== executionWindow.end ? <Text style={styles.compactPeriod}>{[
        provisional ? '仮' : '', executionWindow && executionWindow.start !== executionWindow.end ? calendarPeriodLabel(executionWindow.start, executionWindow.end) : '',
      ].filter(Boolean).join(' · ')}</Text> : null}
    </Pressable>
  </View>;
  return <View style={[styles.row, source && source !== 'personal' && styles.sharedRow, source === 'instructed' && styles.instructedRow,
    deemphasized && !completed && !home && styles.deemphasizedRow, urgent && !completed && styles.urgentRow,
    home && styles.listRow, home && lastInList && styles.lastRow]}>
    {/* Siblings keep the full row opener and checkbox as independent accessible actions. */}
    <Pressable accessibilityRole="button" accessibilityLabel={`${actionName}の説明を開く`}
      accessibilityHint={[source === 'shared' || source === 'instructed' ? '共有の家事です' : source === 'personal' && mixedSources ? '個人の家事です' : '', minutes, period ? `実施期間は${period}です` : '', '手順や道具を確認します'].filter(Boolean).join('。')}
      accessibilityState={detailsExpanded === undefined ? undefined : { expanded: detailsExpanded }} onPress={onOpen}
      style={({ pressed }) => [StyleSheet.absoluteFill, styles.openArea, home && styles.listOpenArea, pressed && styles.pressed]} />
    <View pointerEvents="box-none" style={[styles.content, home && styles.listContent]}>
    {home ? checkbox : null}
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.copy}>
      <Text style={[styles.name, deemphasized && !completed && styles.deemphasizedText, completed && styles.completedText]}>{name}</Text>
      {home ? <View style={styles.metadata}>
        {source === 'shared' || source === 'instructed' ? <View style={styles.sourceIcon}>{sourceIcon === 'person' ? <PersonIcon size={15} /> : <GroupIcon size={22} />}</View> : null}
        {source === 'personal' && mixedSources ? <View style={styles.sourceIcon}><PersonIcon size={15} /></View> : null}
        <Text style={[styles.category, urgent && !completed && styles.urgentText, completed && styles.completedCategory]}>{[
          source === 'instructed' ? '日時指定' : '', minutes,
          urgent && !completed ? '期限間近' : '', executionWindow && period ? calendarPeriodLabel(executionWindow.start, executionWindow.end) : undefined, detail,
        ].filter(Boolean).join(' · ')}</Text>
      </View> : source || urgent || chore.category || period ? <View style={styles.metadata}><Text style={[styles.category, completed && styles.completedCategory]}>{[
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
  compactRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, borderRadius: 7, backgroundColor: palette.accentSoft, overflow: 'hidden' },
  compactCheck: { width: 42, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  compactOpen: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: 5, paddingRight: 6 },
  compactName: { ...typography.label, color: palette.ink, fontWeight: '500' },
  compactPeriod: { ...typography.small, color: palette.muted },
  row: { minHeight: 64, gap: 6, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 9 },
  listRow: { minHeight: 56, paddingVertical: 5, borderRadius: 0, borderWidth: 0, borderLeftWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border }, lastRow: { borderBottomWidth: 0 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 14 }, listContent: { gap: 12 }, listFooter: { paddingLeft: 40 }, action: { minWidth: 44 },
  openArea: { borderRadius: 13, margin: 1 }, listOpenArea: { borderRadius: 0 }, pressed: { backgroundColor: palette.accentSoft },
  sharedRow: { borderLeftWidth: 3, borderLeftColor: palette.shared }, instructedRow: { borderLeftColor: palette.sharedStrong, backgroundColor: palette.sharedSoft },
  urgentRow: { borderLeftWidth: 3, borderLeftColor: palette.gold }, urgentText: { color: palette.gold },
  deemphasizedRow: { backgroundColor: palette.elevated, borderColor: palette.border }, compactCompletedRow: { backgroundColor: palette.surface },
  copy: { flex: 1, minWidth: 0, gap: 2, minHeight: 44, justifyContent: 'center' }, metadata: { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
  sourceIcon: { minHeight: typography.caption.lineHeight, justifyContent: 'center', flexShrink: 0 },
  name: { ...typography.subheading, color: palette.ink, fontWeight: '600' }, category: { ...typography.caption, color: palette.muted, flexShrink: 1 },
  deemphasizedText: { color: palette.muted }, completedText: { color: palette.muted, textDecorationLine: 'line-through' }, completedCategory: { color: palette.muted },
  checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: palette.inputBorder, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  checkboxCompleted: { borderColor: palette.accent, backgroundColor: palette.accent }, checkmark: { color: palette.accentInk, fontSize: 16, fontWeight: '800', lineHeight: 20 },
});
