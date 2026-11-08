import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SettingsSegments } from '../../components/settings-controls';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { NumberInputField } from '../../components/number-input-field';
import { FormTextInput } from '../../components/form-text-input';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import type { ChoreLoad } from '../../domain/chores/types';
import { parseSettingInteger } from '../../domain/chores/settings-patch';
export const initialCustomChoreOptions = { radius: '0', before: '0', after: '0', minutes: '15', load: 'normal' as ChoreLoad, holidayPriority: false, steps: '' };
export function parsedCustomChoreOptions(draft: typeof initialCustomChoreOptions) {
  const integer = (key: 'radius' | 'before' | 'after' | 'minutes') => {
    const value = parseSettingInteger(draft[key], key === 'minutes' ? 1 : 0, key === 'minutes' ? 1440 : 14);
    if (value === undefined) throw new Error(key === 'minutes' ? '目安時間を1〜1440分で入力してください。' : '実施期間の幅を0〜14日で入力してください。'); return value;
  };
  return { windowRadiusDays: integer('radius'), windowBeforeDays: integer('before'), windowAfterDays: integer('after'), estimatedMinutes: integer('minutes'), load: draft.load, holidayPriority: draft.holidayPriority, instructions: draft.steps.split(/\r?\n/u).map(line => line.trim()).filter(Boolean) };
}
export function CustomChoreOptionsFields({ value, onChange, disabled = false, shared = false }: {
  value: typeof initialCustomChoreOptions; onChange(value: Partial<typeof initialCustomChoreOptions>): void; disabled?: boolean; shared?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const row = [styles.row, { borderBottomColor: colors.border }];
  return <>
    <View style={row}><Text style={[typography.body, { color: colors.ink }]}>実施期間の幅</Text>
      {shared ? <View style={{ flexDirection: 'row', gap: 5 }}>{(['before', 'after'] as const).map((key, index) =>
        <NumberInputField key={key} borderless inputWidth={24} prefix={index ? '後' : '前'} accessibilityLabel={`追加する家事の期間の${index ? '後' : '前'}`} value={value[key]} editable={!disabled} onChangeText={text => onChange({ [key]: text })} />)}</View>
        : <NumberInputField borderless prefix="±" accessibilityLabel="追加する家事の期間幅" value={value.radius} editable={!disabled} onChangeText={radius => onChange({ radius })} />}
    </View>
    <View style={row}><Text style={[typography.body, { color: colors.ink }]}>目安時間</Text><NumberInputField borderless suffix="分" accessibilityLabel="追加する家事の目安時間" value={value.minutes} editable={!disabled} onChangeText={minutes => onChange({ minutes })} /></View>
    <View style={row}><Text style={[typography.body, { color: colors.ink }]}>負荷</Text><SettingsSegments value={value.load} disabled={disabled} onValueChange={load => onChange({ load })} options={[{ id: 'light', label: '軽い' }, { id: 'normal', label: '普通' }, { id: 'heavy', label: '重い' }]} /></View>
    {!shared ? <View style={row}><Text style={[typography.body, { color: colors.ink }]}>休日を優先</Text><SettingsCheckbox accessibilityLabel="追加する家事は休日を優先" value={value.holidayPriority} disabled={disabled} onValueChange={holidayPriority => onChange({ holidayPriority })} /></View> : null}
  </>;
}
export function CustomChoreStepsField({ value, onChange, disabled = false }: { value: string; onChange(value: string): void; disabled?: boolean }) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <FormTextInput accessibilityLabel="追加する家事の手順" placeholder="手順（1行に1手順）" value={value} multiline editable={!disabled} onChangeText={onChange}
    style={{ minHeight: 90, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, marginVertical: 10 }} />;
}
const styles = StyleSheet.create({ row: { minHeight: 60, paddingVertical: 6, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 } });
