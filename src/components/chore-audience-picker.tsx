import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GroupIcon, PersonIcon } from './group-icon';
import { palette, typography } from './planner-ui';

export type ChoreAudience = 'personal' | 'shared';

/** The same explicit, fixed-header control for explanations and settings. */
export function ChoreAudiencePicker({ value, purpose, onChange, disabled = false }: {
  value: ChoreAudience; purpose: 'guide' | 'settings'; disabled?: boolean;
  onChange(audience: ChoreAudience): void | Promise<void>;
}) {
  const label = purpose === 'guide' ? '予定先' : '設定先';
  return <View style={styles.destination}><Text style={styles.label}>{label}</Text>
    <View style={styles.audiences} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {(['personal', 'shared'] as const).map(audience => <Pressable key={audience} accessibilityRole="radio"
        accessibilityLabel={`${audience === 'personal' ? '個人用' : 'グループ用'}の家事${purpose === 'guide' ? '説明' : '設定'}`}
        accessibilityState={{ checked: value === audience, disabled }} disabled={disabled}
        onPress={() => { if (!disabled && value !== audience) return onChange(audience); }} style={styles.audience}>
        <View aria-hidden style={[styles.icon, value === audience && styles.selected]}>
          {audience === 'personal' ? <PersonIcon size={16} /> : <GroupIcon size={20} />}
        </View>
      </Pressable>)}
    </View>
  </View>;
}
const styles = StyleSheet.create({
  destination: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { ...typography.caption, color: palette.muted }, audiences: { flexDirection: 'row' },
  audience: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  icon: { width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  selected: { backgroundColor: palette.accentSoft },
});
