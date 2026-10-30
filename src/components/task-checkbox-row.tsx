import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChoreDefinition } from '@/domain/chores/types';
import { palette, typography } from '@/components/planner-ui';
import { GroupIcon, PersonIcon } from './group-icon';
import { Chevron } from './chevron';

export function TaskCheckboxRow({ chore, completed = false, deemphasized = false, source, early = false, urgent = false,
  onToggle, onOpen, home = false, mixedSources = false, detail, detailsExpanded, lastInList = false, contextLabel }: {
  chore: ChoreDefinition; completed?: boolean; deemphasized?: boolean; source?: 'personal' | 'shared' | 'instructed';
  early?: boolean; urgent?: boolean; onToggle?: () => void; onOpen: () => void; home?: boolean; mixedSources?: boolean;
  detail?: string; detailsExpanded?: boolean; lastInList?: boolean; contextLabel?: string;
}) {
  const actionName = `${chore.name}${contextLabel ? `（${contextLabel}）` : ''}`;
  const minutes = Number.isFinite(chore.estimatedMinutes) && chore.estimatedMinutes! > 0 ? `約${chore.estimatedMinutes}分` : '';
  const earlyLabel = early && !completed ? <View style={styles.earlyBadge}><Text style={styles.earlyText}>推奨日前</Text></View> : null;
  const checkbox = <Pressable accessibilityRole="checkbox" accessibilityLabel={`${actionName}を${completed ? '未完了に戻す' : '完了'}`}
    accessibilityState={{ checked: completed, disabled: !onToggle }} disabled={!onToggle} onPress={onToggle} hitSlop={8}
    style={[styles.checkbox, completed && styles.checkboxCompleted]}>
    {completed ? <Text style={styles.checkmark}>✓</Text> : null}
  </Pressable>;
  return <View style={[styles.row, source && source !== 'personal' && styles.sharedRow, source === 'instructed' && styles.instructedRow,
    deemphasized && !completed && styles.deemphasizedRow, early && !completed && styles.earlyRow, urgent && !completed && styles.urgentRow,
    completed && styles.completedRow, home && styles.listRow, home && lastInList && styles.lastRow]}>
    {/* Siblings keep the full row opener and checkbox as independent accessible actions. */}
    <Pressable accessibilityRole="button" accessibilityLabel={`${actionName}の説明を開く`}
      accessibilityHint={[source === 'shared' || source === 'instructed' ? '共有の家事です' : source === 'personal' ? '個人の家事です' : '', minutes, early && !completed ? '推奨日前です' : '', '手順や道具を確認します'].filter(Boolean).join('。')}
      accessibilityState={detailsExpanded === undefined ? undefined : { expanded: detailsExpanded }} onPress={onOpen}
      style={({ pressed }) => [StyleSheet.absoluteFill, styles.openArea, home && styles.listOpenArea, pressed && styles.pressed]} />
    {home ? checkbox : null}
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.copy}>
      <Text style={[styles.name, deemphasized && !completed && styles.deemphasizedText, completed && styles.completedText]}>{chore.name}</Text>
      {home ? <View style={styles.metadata}>
        {source === 'shared' || source === 'instructed' ? <View style={styles.sourceIcon}><GroupIcon size={22} /></View> : null}
        {source === 'personal' && mixedSources ? <View style={styles.sourceIcon}><PersonIcon size={15} /></View> : null}
        <Text style={[styles.category, urgent && !completed && styles.urgentText, completed && styles.completedCategory]}>{[
          source === 'instructed' ? '日時指定' : '', minutes,
          !early && urgent && !completed ? '期限間近' : '', detail,
        ].filter(Boolean).join(' · ')}</Text>
        {earlyLabel}
      </View> : source || early || urgent || chore.category ? <View style={styles.metadata}><Text style={[styles.category, completed && styles.completedCategory]}>{[
        source === 'instructed' ? '共有・日時指定' : source === 'shared' ? '共有' : source === 'personal' ? '個人' : '',
        !early && urgent && !completed ? '期限間近' : '', chore.category,
      ].filter(Boolean).join(' · ')}</Text>{earlyLabel}</View> : null}
    </View>
    <View pointerEvents="none"><Chevron direction={detailsExpanded === undefined ? 'right' : detailsExpanded ? 'up' : 'down'} /></View>
    {!home ? checkbox : null}
  </View>;
}
const styles = StyleSheet.create({
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 9 },
  listRow: { borderRadius: 0, borderWidth: 0, borderLeftWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, gap: 12 }, lastRow: { borderBottomWidth: 0 },
  openArea: { borderRadius: 13, margin: 1 }, listOpenArea: { borderRadius: 0 }, pressed: { backgroundColor: palette.accentSoft },
  sharedRow: { borderLeftWidth: 3, borderLeftColor: palette.shared }, instructedRow: { borderLeftColor: palette.sharedStrong, backgroundColor: palette.sharedSoft },
  urgentRow: { borderLeftWidth: 3, borderLeftColor: palette.gold }, urgentText: { color: palette.gold },
  deemphasizedRow: { backgroundColor: palette.elevated, borderColor: palette.border }, completedRow: { backgroundColor: palette.elevated, borderColor: palette.elevated },
  earlyRow: { backgroundColor: palette.earlySoft, borderColor: palette.border },
  copy: { flex: 1, gap: 2, minHeight: 44, justifyContent: 'center' }, metadata: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5 },
  earlyBadge: { backgroundColor: palette.accentSoft, borderColor: palette.inputBorder, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6 },
  earlyText: { ...typography.caption, color: palette.early, fontWeight: '600' },
  sourceIcon: { height: typography.caption.lineHeight, justifyContent: 'center' },
  name: { ...typography.subheading, color: palette.ink, fontWeight: '600' }, category: { ...typography.caption, color: palette.muted, flexShrink: 1 },
  deemphasizedText: { color: palette.muted }, completedText: { color: palette.muted, textDecorationLine: 'line-through' }, completedCategory: { color: palette.muted },
  checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: palette.inputBorder, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  checkboxCompleted: { borderColor: palette.accent, backgroundColor: palette.accent }, checkmark: { color: palette.accentInk, fontSize: 16, fontWeight: '800', lineHeight: 20 },
});
