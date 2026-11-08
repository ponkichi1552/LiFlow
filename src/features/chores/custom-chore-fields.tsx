import type { ReactNode } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from '../../components/planner-ui';
import { SettingsHeader } from '../../components/settings-header';
import { FormTextInput } from '../../components/form-text-input';
import { NumberInputField } from '../../components/number-input-field';
import { plannerColorsForScheme } from '../../components/planner-theme';

export function ChoreAddHeader({ onBack, disabled = false }: { onBack(): void; disabled?: boolean }) {
  return <SettingsHeader title="家事を追加" onBack={onBack} backDisabled={disabled} />;
}
export function CustomChoreFields({ name, interval, onName, onInterval, disabled = false, cadenceField }: {
  name: string; interval: string; onName(value: string): void; onInterval(value: string): void; disabled?: boolean; cadenceField?: ReactNode;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <>
    <FormTextInput accessibilityLabel="追加する家事の名前" placeholder="家事名" value={name} maxLength={500} editable={!disabled}
      onChangeText={onName} returnKeyType="next" style={[styles.input, { borderColor: colors.inputBorder, color: colors.ink, backgroundColor: colors.background }]} />
    {cadenceField ?? <View style={[styles.row, { borderBottomColor: colors.border }]}><Text style={[typography.body, { color: colors.ink }]}>周期</Text>
      <NumberInputField borderless accessibilityLabel="追加する家事の周期" value={interval} editable={!disabled} onChangeText={onInterval} /></View>}
  </>;
}
const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 48, marginTop: 10, marginBottom: 2 },
  row: { minHeight: 60, paddingVertical: 6, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
