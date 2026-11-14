import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { anchorForMonthlyDay } from '../../calendar/monthly-day';
import { NumberInputField } from '../../../components/number-input-field';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { typography } from '../../../components/planner-typography';
import { SettingsSegments } from '../../../components/settings-controls';
import type { LocalDate } from '../../../domain/shared/types';

/** The recurrence mode and its value are edited together; the start-date field stays separate. */
export function V2ChoreCadence({ anchor, interval, monthly, onInterval, onMonthly, onAnchor, onEndEditing,
  accessibilityLabel, disabled = false, dateDisabled = disabled, modeSelection = true, once = false, onMode }: {
  today: LocalDate; anchor: LocalDate; interval: string; monthly: boolean; onInterval(value: string): void;
  onMonthly(value: boolean): void; onAnchor(value: LocalDate): void; onEndEditing?(): void; accessibilityLabel: string;
  disabled?: boolean; dateDisabled?: boolean; modeSelection?: boolean;
  once?: boolean; onMode?(mode: 'once' | 'interval' | 'monthly'): void;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const [choosingDay, setChoosingDay] = useState(false);
  const day = Number(anchor.slice(8));
  return <>
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Text style={[typography.body, { color: colors.ink }]}>{once ? '繰り返し' : '周期'}</Text>
      <View style={styles.controls}>
        {modeSelection ? <SettingsSegments compact value={once ? 'once' : monthly ? 'monthly' : 'interval'} disabled={dateDisabled}
          options={[...(onMode ? [{ id: 'once', label: '単発' }] : []), { id: 'interval', label: '日数' }, { id: 'monthly', label: '毎月' }]}
          onValueChange={mode => { if (onMode) onMode(mode as 'once' | 'interval' | 'monthly'); else onMonthly(mode === 'monthly'); setChoosingDay(false); }} /> : null}
        {once ? !modeSelection ? <Text style={[typography.body, { color: colors.ink }]}>繰り返さない</Text> : null : monthly && !modeSelection ? <Text style={[typography.body, { color: colors.ink }]}>{`毎月${day}日`}</Text> : monthly ? <Pressable accessibilityRole="button" accessibilityLabel="毎月の日付を変更" accessibilityValue={{ text: `毎月${day}日` }}
          accessibilityState={{ expanded: choosingDay, disabled: dateDisabled }} disabled={dateDisabled} onPress={() => setChoosingDay(value => !value)}
          style={({ pressed }) => [styles.monthDay, { backgroundColor: colors.background }, pressed && { opacity: 0.7 }]}>
          <View style={styles.unitSlot} aria-hidden />
          <Text style={[styles.number, { color: colors.ink }]}>{day}</Text>
          <View style={styles.unitSlot} aria-hidden><Text style={[typography.caption, { color: colors.muted }]}>日</Text></View>
        </Pressable> : <NumberInputField borderless accessibilityLabel={accessibilityLabel} value={interval} editable={!disabled}
          onChangeText={onInterval} onEndEditing={onEndEditing} />}
      </View>
    </View>
    {modeSelection && monthly && choosingDay ? <View>
      <View accessibilityRole="radiogroup" accessibilityLabel="毎月の日付" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        {Array.from({ length: 31 }, (_, index) => index + 1).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`毎月${value}日にする`}
          accessibilityState={{ checked: value === day, disabled: dateDisabled }} disabled={dateDisabled}
          onPress={() => { if (!dateDisabled) { onAnchor(anchorForMonthlyDay(anchor, value)); setChoosingDay(false); } }}
          style={{ width: '13%', minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: value === day ? colors.accentSoft : colors.background }}>
          <Text style={[typography.body, { color: dateDisabled ? colors.disabled : colors.accent }]}>{value}</Text>
        </Pressable>)}
      </View>
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
