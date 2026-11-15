import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { navigationHeaderMetrics, palette, typography } from '../../components/planner-ui';
import { FormTextInput } from '../../components/form-text-input';
import { SettingsHeader } from '../../components/settings-header';
import { SettingsSegments } from '../../components/settings-controls';
import { WeekdayChoices } from '../../components/weekday-choices';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { Chevron } from '../../components/chevron';
import { parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { CalendarOptionPicker } from './calendar-option-picker';
import { calendarWeekday, defaultCustomRecurrence, RECURRENCE_UNITS, validateCustomRecurrence, WEEKDAY_NAMES } from './recurrence';
import type { CustomRecurrence } from './recurrence';

export function CustomRecurrenceScreen({ date, initial, onBack, onSave }: {
  date: LocalDate; initial?: CustomRecurrence; onBack: () => void; onSave: (rule: CustomRecurrence) => Promise<void>;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const { fontScale } = useWindowDimensions();
  const [rule, setRule] = useState(() => initial ?? defaultCustomRecurrence(date)); const [interval, setInterval] = useState(String(rule.interval));
  const latest = useRef({ rule, interval }); const lock = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<'ordinal' | 'weekday' | null>(null);
  const update = (next: CustomRecurrence) => { latest.current.rule = next; setRule(next); setError(null); };
  const count = (text: string) => /^\d{1,3}$/.test(text.normalize('NFKC').trim()) ? Number(text.normalize('NFKC').trim()) : NaN;
  const valid = () => validateCustomRecurrence({ ...latest.current.rule, interval: count(latest.current.interval) });
  const save = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await onSave(valid()); } catch (cause) { setError(cause instanceof Error ? cause.message : '繰り返しを保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const ordinalOptions = [1, 2, 3, 4, 5, -1].map(n => ({ value: String(n), label: n === -1 ? '最後' : `第${n}` }));
  const weekdayOptions = WEEKDAY_NAMES.map((name, index) => ({ value: String(index), label: `${name}曜日` }));
  const monthOrdinal = rule.unit === 'month' && rule.on === 'weekday' ? rule.ordinal : Math.ceil(parseLocalDate(date).getUTCDate() / 7) as 1 | 2 | 3 | 4 | 5;
  const monthWeekday = rule.unit === 'month' && rule.on === 'weekday' ? rule.weekday : calendarWeekday(date);
  const chooseMonthlyWeekday = () => {
    const current = latest.current.rule;
    if (current.unit === 'month' && current.on !== 'weekday') update({ unit: 'month', interval: current.interval, on: 'weekday', ordinal: monthOrdinal, weekday: monthWeekday });
  };
  return <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
    <View style={styles.header}><SettingsHeader title="繰り返しの設定" onBack={onBack} backDisabled={busy} backAccessibilityLabel="予定の入力に戻る"
      action={{ title: busy ? '保存中' : '完了', accessibilityLabel: 'カスタム繰り返しを適用', disabled: busy, onPress: () => void save() }} /></View>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.body}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={[styles.field, styles.intervalGroup]}>
        <SettingsSegments tone="quiet" fullWidth value={rule.unit} disabled={busy} options={(Object.keys(RECURRENCE_UNITS) as CustomRecurrence['unit'][]).map(id => ({ id, label: RECURRENCE_UNITS[id] }))}
          onValueChange={unit => update(defaultCustomRecurrence(date, unit, Number(latest.current.interval) || 1))} />
        <View style={styles.intervalRow}><Text style={[styles.value, { flex: 1 }]}>間隔</Text>
          <FormTextInput accessibilityLabel="繰り返しの間隔" defaultValue={interval} keyboardType="number-pad" maxLength={3} editable={!busy} style={styles.number} onChangeText={text => { latest.current.interval = text; setInterval(text); setError(null); }} />
          <Text style={styles.value}>{rule.unit === 'day' ? '日' : rule.unit === 'week' ? '週間' : rule.unit === 'month' ? 'か月' : '年'}ごと</Text>
        </View>
      </View>
      {rule.unit === 'week' ? <View style={styles.field}><Text style={styles.label}>曜日</Text><WeekdayChoices disabled={busy} selected={rule.weekdays}
        options={[1, 2, 3, 4, 5, 6, 0].map(id => ({ id, label: WEEKDAY_NAMES[id], accessibilityLabel: `${WEEKDAY_NAMES[id]}曜日に繰り返す` }))}
        onToggle={day => { const current = latest.current.rule; if (current.unit === 'week') update({ ...current, weekdays: current.weekdays.includes(day) ? current.weekdays.filter(value => value !== day) : [...current.weekdays, day].sort() }); }} /></View> : null}
      {rule.unit === 'month' ? <View style={styles.field}><Text style={styles.label}>繰り返す日</Text>
        <View style={styles.monthChoices}>
          <Pressable accessibilityRole="radio" accessibilityLabel={`${parseLocalDate(date).getUTCDate()}日`} accessibilityState={{ selected: rule.on === 'date', checked: rule.on === 'date', disabled: busy }} disabled={busy}
            onPress={() => update({ unit: 'month', interval: rule.interval, on: 'date' })} style={styles.monthChoice}>
            <View aria-hidden style={[styles.radio, rule.on === 'date' && styles.radioSelected]}>{rule.on === 'date' ? <View style={styles.radioDot} /> : null}</View><Text style={styles.value}>{parseLocalDate(date).getUTCDate()}日</Text>
          </Pressable>
          <View style={[styles.monthChoice, styles.monthWeekday]}>
            <Pressable accessibilityRole="radio" accessibilityLabel="曜日を指定" accessibilityState={{ selected: rule.on === 'weekday', checked: rule.on === 'weekday', disabled: busy }} disabled={busy} onPress={chooseMonthlyWeekday} style={styles.radioTarget}>
              <View aria-hidden style={[styles.radio, rule.on === 'weekday' && styles.radioSelected]}>{rule.on === 'weekday' ? <View style={styles.radioDot} /> : null}</View>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="月の週を選択" disabled={busy} onPress={() => { chooseMonthlyWeekday(); setPicker('ordinal'); }} style={styles.select}><Text style={styles.value}>{monthOrdinal === -1 ? '最後' : `第${monthOrdinal}`}</Text><Chevron direction="down" /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="月の曜日を選択" disabled={busy} onPress={() => { chooseMonthlyWeekday(); setPicker('weekday'); }} style={styles.select}><Text style={styles.value}>{WEEKDAY_NAMES[monthWeekday]}曜日</Text><Chevron direction="down" /></Pressable>
          </View>
          <Pressable accessibilityRole="radio" accessibilityLabel="複数の日付を指定" accessibilityState={{ selected: rule.on === 'dates', checked: rule.on === 'dates', disabled: busy }} disabled={busy}
            onPress={() => update({ unit: 'month', interval: rule.interval, on: 'dates', days: rule.on === 'dates' ? rule.days : [parseLocalDate(date).getUTCDate()] })} style={[styles.monthChoice, styles.multipleChoice]}>
            <View aria-hidden style={[styles.radio, rule.on === 'dates' && styles.radioSelected]}>{rule.on === 'dates' ? <View style={styles.radioDot} /> : null}</View><Text style={styles.value}>複数の日付</Text>
          </Pressable>
        </View>
        {rule.on === 'dates' ? <View style={styles.monthDays}>{Array.from({ length: 31 }, (_, index) => index + 1).map(day => <Pressable key={day} accessibilityRole="button" accessibilityLabel={`${day}日に繰り返す`}
          accessibilityState={{ selected: rule.days.includes(day), disabled: busy }} disabled={busy}
          onPress={() => { const current = latest.current.rule; if (current.unit === 'month' && current.on === 'dates') update({ ...current, days: current.days.includes(day) ? current.days.filter(value => value !== day) : [...current.days, day].sort((a, b) => a - b) }); }}
          style={({ pressed }) => [styles.monthDay, { width: Math.ceil(44 * Math.max(1, fontScale)) }, rule.days.includes(day) && styles.monthDaySelected, pressed && !busy && { opacity: .7 }]}>
          <Text style={styles.dayNumber}>{day}</Text>
        </Pressable>)}</View> : null}
        {rule.on === 'weekday' && rule.ordinal === 5 || rule.on === 'date' && parseLocalDate(date).getUTCDate() > 28 || rule.on === 'dates' && rule.days.some(day => day > 28) ? <Text style={styles.caption}>指定の日がない月はスキップします。</Text> : null}</View> : null}
      {rule.unit === 'year' && date.slice(5) === '02-29' ? <Text style={styles.caption}>うるう年に繰り返します。</Text> : null}
    </ScrollView>
    {picker && rule.unit === 'month' && rule.on === 'weekday' ? <CalendarOptionPicker title={picker === 'ordinal' ? '週' : '曜日'} value={String(picker === 'ordinal' ? rule.ordinal : rule.weekday)} options={picker === 'ordinal' ? ordinalOptions : weekdayOptions} onClose={() => setPicker(null)}
      onSelect={value => { const current = latest.current.rule; if (current.unit === 'month' && current.on === 'weekday') update({ ...current, ...(picker === 'ordinal' ? { ordinal: Number(value) as -1 | 1 | 2 | 3 | 4 | 5 } : { weekday: Number(value) }) }); }} /> : null}
  </SafeAreaView>;
}
const baseStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, header: { ...navigationHeaderMetrics, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  body: { padding: 16, gap: 24 }, field: { gap: 12 }, intervalGroup: { gap: 20 }, label: { ...typography.label, color: palette.ink, fontWeight: '600' },
  intervalRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, number: { width: 64, minHeight: 46, paddingHorizontal: 4, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 10, textAlign: 'center', fontVariant: ['tabular-nums'] },
  monthChoices: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, monthChoice: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 6 }, monthWeekday: { paddingLeft: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, radioTarget: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: palette.inputBorder, alignItems: 'center', justifyContent: 'center' }, radioSelected: { borderColor: palette.accent }, radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: palette.accent },
  multipleChoice: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, monthDays: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  monthDay: { minHeight: 44, borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 20, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  monthDaySelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft }, dayNumber: { ...typography.body, color: palette.accent },
  select: { flex: 1, minHeight: 46, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12 }, value: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted }, error: { ...typography.body, color: palette.warning },
});
