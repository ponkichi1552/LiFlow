import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { CalendarDayPicker } from '../../../components/calendar-day-picker';
import { NumberInputField } from '../../../components/number-input-field';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { typography } from '../../../components/planner-typography';
import { SettingsSegments } from '../../../components/settings-controls';
import type { LocalDate } from '../../../domain/shared/types';

/** The recurrence mode and its value are edited together; the start-date field stays separate. */
export function V2ChoreCadence({ today, anchor, interval, monthly, onInterval, onMonthly, onAnchor, onEndEditing,
  accessibilityLabel, disabled = false, dateDisabled = disabled }: {
  today: LocalDate; anchor: LocalDate; interval: string; monthly: boolean; onInterval(value: string): void;
  onMonthly(value: boolean): void; onAnchor(value: LocalDate): void; onEndEditing?(): void; accessibilityLabel: string;
  disabled?: boolean; dateDisabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const [choosingDay, setChoosingDay] = useState(false);
  const day = Number(anchor.slice(8));
  return <>
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Text style={[typography.body, { color: colors.ink }]}>周期</Text>
      <View style={styles.controls}>
        <SettingsSegments compact value={monthly ? 'monthly' : 'interval'} disabled={dateDisabled}
          options={[{ id: 'interval', label: '日数' }, { id: 'monthly', label: '毎月' }]}
          onValueChange={mode => { onMonthly(mode === 'monthly'); setChoosingDay(false); }} />
        {monthly ? <Pressable accessibilityRole="button" accessibilityLabel="毎月の日付を変更" accessibilityValue={{ text: `毎月${day}日` }}
          accessibilityState={{ expanded: choosingDay, disabled: dateDisabled }} disabled={dateDisabled} onPress={() => setChoosingDay(value => !value)}
          style={({ pressed }) => [styles.monthDay, { backgroundColor: colors.background }, pressed && { opacity: 0.7 }]}>
          <View style={styles.unitSlot} aria-hidden />
          <Text style={[styles.number, { color: colors.ink }]}>{day}</Text>
          <View style={styles.unitSlot} aria-hidden><Text style={[typography.caption, { color: colors.muted }]}>日</Text></View>
        </Pressable> : <NumberInputField borderless accessibilityLabel={accessibilityLabel} value={interval} editable={!disabled}
          onChangeText={onInterval} onEndEditing={onEndEditing} />}
      </View>
    </View>
    {monthly && choosingDay ? <View>
      <CalendarDayPicker key={anchor.slice(0, 7)} today={today} initialDate={anchor} label="毎月の日付カレンダー" disabled={dateDisabled}
        selected={date => date === anchor} describe={date => `毎月${Number(date.slice(8))}日にする`}
        onSelect={date => { if (!dateDisabled) { onAnchor(date); setChoosingDay(false); } }} />
      {day > 28 ? <Text style={[typography.caption, { color: colors.muted }]}>日付のない月は月末になります。</Text> : null}
    </View> : null}
  </>;
}

const styles = StyleSheet.create({
  row: { minHeight: 60, paddingVertical: 8, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  monthDay: { minHeight: 46, flexDirection: 'row', alignItems: 'center', borderRadius: 11, paddingHorizontal: 6 },
  unitSlot: { width: 16, alignItems: 'center', justifyContent: 'center' },
  number: { ...typography.control, fontWeight: '700', width: 48, textAlign: 'center' },
});
