import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { AccordionSection } from '../../../components/accordion-section';
import { typography } from '../../../components/planner-ui';
import { SettingsAction } from '../../../components/settings-controls';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { Chevron } from '../../../components/chevron';
import type { V2GroupScreenModel } from '../v2/controller';
import type { SharedChoreRotation } from '../v2/model';
import { V2Choices } from './form-controls';
import { v2MemberLabels } from './member-labels';

/** Sequence slots preserve repeated people, so A → A → B means one B turn in three. */
export function V2RotationSettings({ members, value, onChange, disabled = false, unfolded = false }: {
  members: V2GroupScreenModel['plan']['members']; value: SharedChoreRotation;
  onChange(update: (current: SharedChoreRotation) => SharedChoreRotation): void; disabled?: boolean; unfolded?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const nameOf = v2MemberLabels(members);
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<number | null>(null);
  const active = members.filter(member => member.active);
  const change = (update: (current: string[]) => string[]) => { if (!disabled) { setEditing(null); onChange(current => ({ ...current, sequence: update(current.sequence) })); } };
  const move = (index: number, by: number) => {
    change(current => { const next = [...current]; const other = index + by;
      if (other < 0 || other >= next.length) return next;
      [next[index], next[other]] = [next[other], next[index]]; return next;
    });
  };
  const body = <>
    <Text style={[typography.caption, { color: colors.muted }]}>交代の順番</Text>
    {value.sequence.map((id, index) => <View key={index}>
      <View style={[styles.row, { borderBottomColor: colors.border }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`交代の${index + 1}番目を変更`} disabled={disabled}
          onPress={() => setEditing(editing === index ? null : index)} style={[styles.member, { borderColor: colors.inputBorder, backgroundColor: colors.surface }]}>
          <Text style={[typography.body, { color: colors.ink, flexShrink: 1 }]}>{index + 1}. {nameOf(id)}</Text><Chevron direction="down" />
        </Pressable>
        <View style={styles.actions}>
          <SettingsAction title="↑" accessibilityLabel={`交代の${index + 1}番目を上へ`} disabled={disabled || index === 0} onPress={() => move(index, -1)} />
          <SettingsAction title="↓" accessibilityLabel={`交代の${index + 1}番目を下へ`} disabled={disabled || index === value.sequence.length - 1} onPress={() => move(index, 1)} />
          <SettingsAction title="×" intent="destructive" accessibilityLabel={`交代の${index + 1}番目を削除`} disabled={disabled} onPress={() => change(current => current.filter((_, i) => i !== index))} />
        </View>
      </View>
      {editing === index ? active.map(member => <SettingsAction key={member.userId} title={nameOf(member.userId)} accessibilityLabel={`交代の${index + 1}番目：${nameOf(member.userId)}`}
        disabled={disabled} onPress={() => change(current => current.map((id, i) => i === index ? member.userId : id))} />) : null}
    </View>)}
    <SettingsAction title="順番を追加" disabled={disabled || !active.length || value.sequence.length >= 64}
      onPress={() => change(current => current.length >= 64 ? current : [...current, active.find(member => !current.includes(member.userId))?.userId ?? active[0].userId])} />
    <V2Choices compact label="交代のタイミング" value={value.advanceOn} disabled={disabled}
      choices={[{ value: 'completion', label: '完了したら交代', shortLabel: '完了後' }, { value: 'occurrence', label: '予定ごとに交代', shortLabel: '予定ごと' }]}
      onChange={advanceOn => { if (!disabled) onChange(current => ({ ...current, advanceOn })); }} />
  </>;
  return unfolded ? <View>{body}</View> : <AccordionSection plain title="交代の設定" expanded={open} onToggle={() => setOpen(v => !v)}>{body}</AccordionSection>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, borderBottomWidth: 1, paddingVertical: 4 },
  member: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5 },
  actions: { flexDirection: 'row', gap: 4 },
});
