import { useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import { parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { minuteLabel } from './events';
import { plannerColorsForScheme, plannerPressColorsForScheme } from '../../components/planner-theme';
import { CalendarTextAction } from './calendar-sheet-header';

/** Pick civil fields in a neutral clock; the event's own timezone validates actual instants later. */
export function CalendarField({ label, date, minute, mode, onDate, onMinute, disabled = false, hideLabel = false, displayValue, commitOnDone = false, borderless = false, empty = false }: {
  label: string; date: LocalDate; minute: number; mode: 'date' | 'time'; onDate?: (date: LocalDate) => void; onMinute?: (minute: number) => void;
  disabled?: boolean; hideLabel?: boolean; displayValue?: string; commitOnDone?: boolean | 'or-backdrop'; borderless?: boolean; empty?: boolean;
}) {
  const [open, setOpen] = useState(false); const scheme = useColorScheme(); const parsed = parseLocalDate(date); const insets = useSafeAreaInsets();
  const [pickedValue, setPickedValue] = useState<Date | null>(null);
  const pickerSession = useRef<{ value: Date; selected: boolean } | null>(null);
  const colors = plannerColorsForScheme(scheme);
  const pressColors = plannerPressColorsForScheme(scheme);
  const value = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), mode === 'date' ? 12 : Math.floor(minute / 60), mode === 'date' ? 0 : minute % 60));
  const accept = (picked?: Date) => { if (!picked || disabled || !Number.isFinite(picked.getTime())) return;
    if (mode === 'date') onDate?.(picked.toISOString().slice(0, 10) as LocalDate); else onMinute?.(picked.getUTCHours() * 60 + picked.getUTCMinutes()); };
  const finishPicker = (from: 'done' | 'backdrop') => {
    const session = pickerSession.current;
    if (!session) return;
    pickerSession.current = null;
    setOpen(false);
    if (commitOnDone && (from === 'done' || (commitOnDone === 'or-backdrop' && session.selected))) accept(session.value);
    else if (!commitOnDone && from === 'done' && displayValue !== undefined) accept(value);
  };
  return <View style={styles.wrap}>{!hideLabel ? <Text style={styles.label}>{label}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}を選択`} accessibilityValue={{ text: empty ? '未指定' : displayValue ?? (mode === 'date' ? date.replaceAll('-', '/') : minuteLabel(minute)) }} disabled={disabled} onPress={() => {
      if (Platform.OS === 'android') DateTimePickerAndroid.open({ value, mode, is24Hour: true, timeZoneName: 'UTC',
        ...(mode === 'time' ? { minuteInterval: 5 as const, display: 'spinner' as const } : {}), onValueChange: (_event, picked) => accept(picked) });
      else { pickerSession.current = { value, selected: false }; setPickedValue(value); setOpen(true); }
    }} style={({ pressed }) => [styles.button, { borderColor: colors.inputBorder }, borderless && { borderWidth: 0, backgroundColor: colors.surface },
      pressed && !disabled && { backgroundColor: pressColors.tinted }]}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.8} style={[styles.value, { color: empty ? colors.muted : colors.ink }]}>{empty ? '--:--' : displayValue ?? (mode === 'date' ? date.replaceAll('-', '/') : minuteLabel(minute))}</Text>
      <SymbolView name={mode === 'date' ? { ios: 'calendar', android: 'calendar_month' } : { ios: 'clock', android: 'schedule' }} size={19} tintColor={colors.accent} /></Pressable>
    {open && Platform.OS === 'ios' ? <Modal transparent animationType="fade" onRequestClose={() => finishPicker('backdrop')}>
      <View style={styles.pickerOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="日時選択を閉じる" onPress={() => finishPicker('backdrop')} style={StyleSheet.absoluteFill} />
        <View style={[styles.pickerPanel, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <View style={[styles.pickerHeader, { borderColor: colors.border }]}><View style={styles.actionSlot} /><Text style={styles.pickerTitle}>{label}</Text><CalendarTextAction title="完了" label={`${label}の選択を完了`} onPress={() => finishPicker('done')} /></View>
          <DateTimePicker value={commitOnDone ? pickedValue ?? value : value} mode={mode} timeZoneName="UTC" display="spinner" minuteInterval={mode === 'time' ? 5 : 1} locale="ja-JP" disabled={disabled} themeVariant={scheme === 'dark' ? 'dark' : 'light'}
            onValueChange={(_event, picked) => {
              if (!pickerSession.current || !picked || !Number.isFinite(picked.getTime())) return;
              if (!commitOnDone) { accept(picked); return; }
              pickerSession.current = { value: picked, selected: true };
              setPickedValue(picked);
            }} style={styles.picker} />
        </View>
      </View>
    </Modal> : null}
  </View>;
}
const styles = StyleSheet.create({ wrap: { flex: 1, gap: 5 }, label: { ...typography.caption, color: palette.muted },
  button: { borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12, minHeight: 46, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  value: { ...typography.body, color: palette.ink, flex: 1 },
  pickerOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay },
  pickerPanel: { backgroundColor: palette.elevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  // Keep the native wheel's measured width; stretching its host leaves the wheels at the leading edge.
  picker: { height: 200, alignSelf: 'center', maxWidth: '100%' },
  pickerHeader: { minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  pickerTitle: { ...typography.body, color: palette.ink, fontWeight: '700', flex: 1, textAlign: 'center' },
  actionSlot: { width: 64 },
});
