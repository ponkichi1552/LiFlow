import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, typography } from '@/components/planner-ui';
import type { WasteCollectionOccurrence } from '@/features/waste/contracts';
import { GroupIcon, PersonIcon } from './group-icon';
import { WasteTypeIcon } from './waste-type-icon';

/** Home uses a leading check; calendar keeps its aligned trailing check. */
export function WasteOccurrenceCard({ occurrence, compact = false, hidden = false, busy = false, onToggle, home = false, source }: {
  occurrence: WasteCollectionOccurrence;
  compact?: boolean;
  hidden?: boolean;
  busy?: boolean;
  onToggle: () => void;
  home?: boolean;
  source?: 'personal' | 'shared';
}) {
  const action = <Pressable accessibilityRole="checkbox"
    accessibilityLabel={`${occurrence.label}${source ? `（${source === 'personal' ? '個人' : '共有'}）` : ''}の${occurrence.date}のゴミ出しを${hidden ? '再表示' : '非表示'}`}
    accessibilityState={{ checked: hidden, disabled: busy }} disabled={busy} hitSlop={8} onPress={onToggle} style={styles.action}>
    {compact ? <Text style={styles.caption}>ゴミ出し非表示</Text> : null}
    <View style={styles.checkboxColumn}><View style={[styles.checkbox, compact && styles.compactCheckbox, hidden && styles.checked]}>
      {hidden ? <Text style={styles.checkmark}>✓</Text> : null}
    </View></View>
  </Pressable>;
  return (
    <View style={[styles.row, compact && styles.compactRow, home && styles.homeRow]}>
      {home ? action : null}
      <View style={styles.copy}>
        <View style={styles.nameRow}><WasteTypeIcon label={occurrence.label} size={compact ? 18 : 21} /><Text style={[styles.name, compact && styles.compactName]}>{occurrence.label}</Text></View>
        {!compact ? <View style={styles.metadata}>{source === 'shared' ? <GroupIcon size={22} /> : source === 'personal' ? <PersonIcon size={15} /> : null}<Text style={styles.caption}>ゴミ出し</Text></View> : null}
      </View>
      {!home ? action : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 12 },
  compactRow: { minHeight: 56, paddingVertical: 5 },
  homeRow: { minHeight: 64, paddingVertical: 9, gap: 12 }, metadata: { flexDirection: 'row', alignItems: 'center', gap: 5 },
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
