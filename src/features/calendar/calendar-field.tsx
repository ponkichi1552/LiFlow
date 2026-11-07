import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import { parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { minuteLabel } from './events';

/** Pick civil fields in a neutral clock; the event's own timezone validates actual instants later. */
export function CalendarField({ label, date, minute, mode, onDate, onMinute, disabled = false, hideLabel = false }: {
  label: string; date: LocalDate; minute: number; mode: 'date' | 'time'; onDate?: (date: LocalDate) => void; onMinute?: (minute: number) => void;
  disabled?: boolean; hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false); const scheme = useColorScheme(); const parsed = parseLocalDate(date); const insets = useSafeAreaInsets();
  const value = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), mode === 'date' ? 12 : Math.floor(minute / 60), mode === 'date' ? 0 : minute % 60));
  const accept = (picked?: Date) => { if (!picked || disabled || !Number.isFinite(picked.getTime())) return;
    if (mode === 'date') onDate?.(picked.toISOString().slice(0, 10) as LocalDate); else onMinute?.(picked.getUTCHours() * 60 + picked.getUTCMinutes()); };
  return <View style={styles.wrap}>{!hideLabel ? <Text style={styles.label}>{label}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}を選択`} accessibilityValue={{ text: mode === 'date' ? date.replaceAll('-', '/') : minuteLabel(minute) }} disabled={disabled} onPress={() => {
      if (Platform.OS === 'android') DateTimePickerAndroid.open({ value, mode, is24Hour: true, timeZoneName: 'UTC',
        ...(mode === 'time' ? { minuteInterval: 5 as const, display: 'spinner' as const } : {}), onValueChange: (_event, picked) => accept(picked) });
      else setOpen(v => !v);
    }} style={styles.button}><Text style={styles.value}>{mode === 'date' ? date.replaceAll('-', '/') : minuteLabel(minute)}</Text>
      <SymbolView name={mode === 'date' ? { ios: 'calendar', android: 'calendar_month' } : { ios: 'clock', android: 'schedule' }} size={19} tintColor={palette.accent} /></Pressable>
    {open && Platform.OS === 'ios' ? <Modal transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.pickerOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="日時選択を閉じる" onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <View style={[styles.pickerPanel, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <View style={styles.pickerHeader}><Text style={styles.pickerTitle}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${label}の選択を完了`} onPress={() => setOpen(false)} style={styles.done}><Text style={styles.doneText}>完了</Text></Pressable></View>
          <DateTimePicker value={value} mode={mode} timeZoneName="UTC" display="spinner" minuteInterval={mode === 'time' ? 5 : 1} locale="ja-JP" disabled={disabled} themeVariant={scheme === 'dark' ? 'dark' : 'light'}
            onValueChange={(_event, picked) => accept(picked)} style={{ height: 200, width: '100%' }} />
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
  pickerHeader: { minHeight: 48, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  pickerTitle: { ...typography.subheading, color: palette.ink, fontWeight: '600', flex: 1 },
  done: { minHeight: 44, minWidth: 52, alignItems: 'flex-end', justifyContent: 'center' }, doneText: { ...typography.body, color: palette.accent },
});
