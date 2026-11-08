import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { typography } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import type { V2GroupScreenModel } from '../v2/controller';
import { V2Choices } from './form-controls';
import { v2MemberLabels } from './member-labels';

export type V2ResponsibilityPreset = '' | 'common' | 'eachMember' | 'assigned' | 'rotation';

/** The initial and autosaved editors use the same role choices and member controls. */
export function V2ResponsibilityChoices({ members, preset, memberIds, onPreset, onMember, disabled = false }: {
  members: V2GroupScreenModel['plan']['members']; preset: V2ResponsibilityPreset; memberIds: readonly string[];
  onPreset(value: Exclude<V2ResponsibilityPreset, ''>): void; onMember(userId: string, checked: boolean): void; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const nameOf = v2MemberLabels(members);
  const rowStyle = [styles.row, { borderBottomColor: colors.border }];
  return <View>
    <View style={[rowStyle, { paddingVertical: 0 }]}><V2Choices compact label="担当" value={preset} disabled={disabled}
      onChange={value => { if (value && value !== preset && !disabled) onPreset(value); }} choices={[
        { value: 'common', label: '誰か1人が行う', shortLabel: '誰か1人', weight: 1.8 },
        { value: 'eachMember', label: 'メンバーごとに行う', shortLabel: '各自' },
        { value: 'assigned', label: '担当者を決める', shortLabel: '指定' },
        { value: 'rotation', label: '交代で行う', shortLabel: '交代' },
      ]} /></View>
    {preset === 'assigned' || preset === 'rotation' ? members.filter(member => member.active).map(member => <View key={member.userId} style={rowStyle}>
      <Text style={[styles.name, { color: colors.ink }]}>{nameOf(member.userId)}</Text>
      <SettingsCheckbox accessibilityLabel={`担当：${nameOf(member.userId)}`} value={memberIds.includes(member.userId)} disabled={disabled}
        onValueChange={checked => { if (!disabled) onMember(member.userId, checked); }} />
    </View>) : null}
  </View>;
}
const styles = StyleSheet.create({
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  name: { ...typography.body, flexShrink: 1 },
});
