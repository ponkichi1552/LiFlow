import DateTimePicker from '@react-native-community/datetimepicker';
import { Platform, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from '../../components/planner-typography';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { SettingsPanel } from '../../components/settings-controls';
import { parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { CalendarField } from './calendar-field';
import { moveCalendarStart } from './event-editing';
import type { EventDraft } from './events';

export function ChoreDateFields({ date, timed, displayTimeZone, disabled = false, onDateChange, onTimedChange }: {
  date?: LocalDate; timed?: EventDraft | null; displayTimeZone: string; disabled?: boolean;
  onDateChange(value: LocalDate): void; onTimedChange(update: (value: EventDraft) => EventDraft): void;
}) {
  const scheme = useColorScheme();
  const colors = plannerColorsForScheme(scheme);
  if (timed) return <SettingsPanel>
    <View style={styles.dateFields}>
      <View style={styles.dateRow}><Text style={[typography.body, { color: colors.ink }]}>開始</Text>
        <CalendarField borderless hideLabel commitOnDone="or-backdrop" label="開始日" date={timed.startDate} minute={0} mode="date" disabled={disabled}
          onDate={startDate => onTimedChange(before => moveCalendarStart(before, { startDate }))} />
        <View style={styles.timeField}><CalendarField borderless hideLabel commitOnDone="or-backdrop" label="開始時刻" date={timed.startDate} minute={timed.startMinute} mode="time" disabled={disabled}
          onMinute={startMinute => onTimedChange(before => moveCalendarStart(before, { startMinute }))} /></View>
      </View>
      <View style={styles.dateRow}><Text style={[typography.body, { color: colors.ink }]}>終了</Text>
        <CalendarField borderless hideLabel commitOnDone="or-backdrop" label="終了日" date={timed.endDate} minute={0} mode="date" disabled={disabled}
          onDate={endDate => onTimedChange(before => ({ ...before, endDate }))} />
        <View style={styles.timeField}><CalendarField borderless hideLabel commitOnDone="or-backdrop" label="終了時刻" date={timed.endDate} minute={timed.endMinute} mode="time" disabled={disabled}
          onMinute={endMinute => onTimedChange(before => ({ ...before, endMinute }))} /></View>
      </View>
    </View>
    {timed.timeZone !== displayTimeZone ? <Text style={[typography.caption, { color: colors.muted }]}>地域：{timed.timeZone}</Text> : null}
  </SettingsPanel>;
  if (!date) return null;
  if (Platform.OS !== 'ios') return <CalendarField label="今回の実施日" date={date} minute={0} mode="date" disabled={disabled} onDate={onDateChange} />;
  return <DateTimePicker accessibilityLabel="今回の実施日" value={parseLocalDate(date)} mode="date" display="spinner" locale="ja-JP" timeZoneName="UTC"
    themeVariant={scheme === 'dark' ? 'dark' : 'light'} textColor={colors.ink} accentColor={colors.accent} disabled={disabled} style={styles.picker}
    onValueChange={(_event, value) => { if (!disabled && value && Number.isFinite(value.getTime())) onDateChange(value.toISOString().slice(0, 10) as LocalDate); }} />;
}

const styles = StyleSheet.create({
  picker: { alignSelf: 'center', maxWidth: '100%', height: 200 },
  dateFields: { gap: 8 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeField: { width: 100, flexShrink: 0 },
});
