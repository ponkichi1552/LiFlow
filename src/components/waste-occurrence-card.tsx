import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { palette, typography } from '@/components/planner-ui';
import type { WasteCollectionOccurrence } from '@/features/waste/contracts';
import { GroupIcon, PersonIcon } from './group-icon';
import { WasteTypeIcon } from './waste-type-icon';
import { plannerColorsForScheme } from './planner-theme';
import { formatJapaneseDate } from '../domain/scheduling/local-date';
import { useWasteTypeColor } from '../features/waste/use-waste-type-color';

/** Collection reminders are display-only; management can explicitly offer visibility controls. */
export function WasteOccurrenceCard({ occurrence, compact = false, hidden = false, busy = false, onToggle, home = false, source, listRow = false }: {
  occurrence: WasteCollectionOccurrence;
  compact?: boolean;
  hidden?: boolean;
  busy?: boolean;
  onToggle?: () => void;
  home?: boolean;
  source?: 'personal' | 'shared';
  listRow?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const wasteColor = useWasteTypeColor();
  const action = onToggle ? <Pressable accessibilityRole="checkbox"
    accessibilityLabel={`${occurrence.label}${source ? `（${source === 'personal' ? '個人' : '共有'}）` : ''}の${occurrence.date}のゴミ出しを${hidden ? '再表示' : '非表示'}`}
    accessibilityState={{ checked: hidden, disabled: busy }} disabled={busy} hitSlop={8} onPress={onToggle}
    style={[styles.action, listRow && [styles.listAction, { borderColor: colors.border, backgroundColor: colors.surface }], busy && { opacity: 0.5 }]}>
    {listRow ? <Text style={[styles.caption, { color: hidden ? colors.accent : colors.muted }]}>{hidden ? '再表示' : '今回は非表示'}</Text> : compact ? <Text style={styles.caption}>ゴミ出し非表示</Text> : null}
    {!listRow ? <View style={styles.checkboxColumn}><View style={[styles.checkbox, { borderColor: colors.inputBorder, backgroundColor: colors.surface }, compact && styles.compactCheckbox, hidden && { borderColor: colors.accent, backgroundColor: colors.accent }]}>
      {hidden ? <Text style={styles.checkmark}>✓</Text> : null}
    </View></View> : null}
  </Pressable> : null;
  return (
    <View style={[styles.row, { borderColor: colors.border, backgroundColor: colors.surface }, compact && styles.compactRow, home && styles.homeRow, listRow && styles.listRow]}>
      {home ? action : null}
      <View style={styles.copy}>
        {listRow ? <Text style={[styles.listDate, { color: colors.ink }]}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text> : null}
        <View style={styles.nameRow}><WasteTypeIcon label={occurrence.label} size={listRow ? 16 : compact || home ? 18 : 21} /><Text style={[styles.name, (compact || home) && styles.compactName, home && styles.homeName, listRow && [styles.listName, { color: wasteColor(occurrence.label) }]]}>{occurrence.label}</Text>
          {home && source ? <View accessibilityLabel={source === 'personal' ? '個人' : '共有'}>{source === 'shared' ? <GroupIcon size={22} /> : <PersonIcon size={17} />}</View> : null}
        </View>
        {!compact && !home ? <View style={styles.metadata}>{source === 'shared' ? <GroupIcon size={22} /> : source === 'personal' ? <PersonIcon size={15} /> : null}<Text style={styles.caption}>ゴミ出し</Text></View> : null}
      </View>
      {!home ? action : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 12 },
  compactRow: { minHeight: 56, paddingVertical: 5 },
  listRow: { borderRadius: 0, borderWidth: 0, borderBottomWidth: 1, paddingHorizontal: 0, backgroundColor: 'transparent' },
  listAction: { borderRadius: 10, paddingHorizontal: 12 }, listDate: { ...typography.label, fontWeight: '500' }, listName: { ...typography.caption, fontWeight: '500' },
  homeRow: { minHeight: 48, paddingVertical: 7, gap: 12 }, homeName: { flex: 1 }, metadata: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  copy: { flex: 1, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { ...typography.subheading, color: palette.ink, fontWeight: '600', flexShrink: 1 },
  compactName: { ...typography.body },
  caption: { ...typography.caption, color: palette.muted },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkboxColumn: { width: 28, alignItems: 'center' },
  checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: palette.inputBorder, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  compactCheckbox: { width: 24, height: 24, borderRadius: 7 },
  checked: { borderColor: palette.accent, backgroundColor: palette.accent },
  checkmark: { color: palette.accentInk, fontSize: 16, fontWeight: '800', lineHeight: 20 },
});
