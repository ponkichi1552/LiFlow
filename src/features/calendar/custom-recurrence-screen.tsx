import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, ChoiceChip, navigationHeaderMetrics, palette, typography } from '../../components/planner-ui';
import { FormTextInput } from '../../components/form-text-input';
import { Chevron } from '../../components/chevron';
import { parseLocalDate, weekdayOf } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { CalendarOptionPicker } from './calendar-option-picker';
import { customRecurrenceLabel, defaultCustomRecurrence, RECURRENCE_UNITS, validateCustomRecurrence, WEEKDAY_NAMES } from './recurrence';
import type { CustomRecurrence } from './recurrence';

export function CustomRecurrenceScreen({ date, initial, onBack, onSave }: {
  date: LocalDate; initial?: CustomRecurrence; onBack: () => void; onSave: (rule: CustomRecurrence) => Promise<void>;
}) {
  const [rule, setRule] = useState(() => initial ?? defaultCustomRecurrence(date)); const [interval, setInterval] = useState(String(rule.interval));
  const latest = useRef({ rule, interval }); const lock = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<'ordinal' | 'weekday' | null>(null);
  const update = (next: CustomRecurrence) => { latest.current.rule = next; setRule(next); setError(null); };
  const count = (text: string) => /^\d{1,3}$/.test(text.normalize('NFKC').trim()) ? Number(text.normalize('NFKC').trim()) : NaN;
  const valid = () => validateCustomRecurrence({ ...latest.current.rule, interval: count(latest.current.interval) });
  let summary: string; try { summary = customRecurrenceLabel(validateCustomRecurrence({ ...rule, interval: count(interval) }), date); } catch { summary = '間隔・曜日を選択してください。'; }
  const save = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await onSave(valid()); } catch (cause) { setError(cause instanceof Error ? cause.message : '繰り返しを保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const ordinalOptions = [1, 2, 3, 4, 5, -1].map(n => ({ value: String(n), label: n === -1 ? '最後' : `第${n}` }));
  const weekdayOptions = WEEKDAY_NAMES.map((name, index) => ({ value: String(index), label: `${name}曜日` }));
  return <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
    <View style={styles.header}><View style={styles.headerSide}><BackButton accessibilityLabel="予定の入力に戻る" onPress={onBack} disabled={busy} /></View><Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>カスタム</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="カスタム繰り返しを適用" disabled={busy} onPress={() => void save()} style={[styles.headerSide, styles.apply]}><Text style={styles.action}>{busy ? '保存中' : '完了'}</Text></Pressable></View>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.body}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.field}><Text style={styles.label}>間隔</Text><View style={styles.intervalRow}>
        <FormTextInput accessibilityLabel="繰り返しの間隔" defaultValue={interval} keyboardType="number-pad" maxLength={3} editable={!busy} style={styles.number} onChangeText={text => { latest.current.interval = text; setInterval(text); setError(null); }} />
        <View style={styles.units}>{(Object.keys(RECURRENCE_UNITS) as CustomRecurrence['unit'][]).map(unit => <ChoiceChip key={unit} label={RECURRENCE_UNITS[unit]} selected={rule.unit === unit} disabled={busy} onPress={() => update(defaultCustomRecurrence(date, unit, Number(latest.current.interval) || 1))} />)}</View>
      </View><Text style={styles.caption}>{rule.unit === 'day' ? '日' : rule.unit === 'week' ? '週間' : rule.unit === 'month' ? 'か月' : '年'}ごとに繰り返す</Text></View>
      {rule.unit === 'week' ? <View style={styles.field}><Text style={styles.label}>曜日</Text><View style={styles.weekdays}>{WEEKDAY_NAMES.map((name, index) => <Pressable key={name} accessibilityRole="button" accessibilityLabel={`${name}曜日に繰り返す`} accessibilityState={{ selected: rule.weekdays.includes(index) }} disabled={busy}
        onPress={() => { const current = latest.current.rule; if (current.unit === 'week') update({ ...current, weekdays: current.weekdays.includes(index) ? current.weekdays.filter(day => day !== index) : [...current.weekdays, index].sort() }); }} style={[styles.weekday, rule.weekdays.includes(index) && styles.selected]}><Text style={[styles.weekdayText, rule.weekdays.includes(index) && styles.selectedText]}>{name}</Text></Pressable>)}</View></View> : null}
      {rule.unit === 'month' ? <View style={styles.field}><Text style={styles.label}>毎月の指定</Text><View style={styles.units}>
        <ChoiceChip label={`${parseLocalDate(date).getUTCDate()}日`} selected={rule.on === 'date'} disabled={busy} onPress={() => update({ unit: 'month', interval: rule.interval, on: 'date' })} />
        <ChoiceChip label="第N曜日" selected={rule.on === 'weekday'} disabled={busy} onPress={() => update({ unit: 'month', interval: rule.interval, on: 'weekday', ordinal: Math.ceil(parseLocalDate(date).getUTCDate() / 7) as 1 | 2 | 3 | 4 | 5, weekday: weekdayOf(date) })} />
      </View>{rule.on === 'weekday' ? <View style={styles.intervalRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="月の週を選択" disabled={busy} onPress={() => setPicker('ordinal')} style={styles.select}><Text style={styles.value}>{rule.ordinal === -1 ? '最後' : `第${rule.ordinal}`}</Text><Chevron direction="down" /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="月の曜日を選択" disabled={busy} onPress={() => setPicker('weekday')} style={styles.select}><Text style={styles.value}>{WEEKDAY_NAMES[rule.weekday]}曜日</Text><Chevron direction="down" /></Pressable>
      </View> : null}<Text style={styles.caption}>指定した日付・第5曜日が存在しない月には、その回を作りません。</Text></View> : null}
      {rule.unit === 'year' ? <Text style={styles.caption}>開始日の月日で繰り返します。2月29日は、うるう年だけ表示します。</Text> : null}
      <View style={styles.preview}><Text style={styles.previewLabel}>繰り返し</Text><Text style={styles.previewText}>{summary}</Text></View>
    </ScrollView>
    {picker && rule.unit === 'month' && rule.on === 'weekday' ? <CalendarOptionPicker title={picker === 'ordinal' ? '週' : '曜日'} value={String(picker === 'ordinal' ? rule.ordinal : rule.weekday)} options={picker === 'ordinal' ? ordinalOptions : weekdayOptions} onClose={() => setPicker(null)}
      onSelect={value => { const current = latest.current.rule; if (current.unit === 'month' && current.on === 'weekday') update({ ...current, ...(picker === 'ordinal' ? { ordinal: Number(value) as -1 | 1 | 2 | 3 | 4 | 5 } : { weekday: Number(value) }) }); }} /> : null}
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, header: { ...navigationHeaderMetrics, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, headerSide: { width: 88, minHeight: 48, justifyContent: 'center' }, apply: { alignItems: 'flex-end' },
  title: { ...typography.subheading, color: palette.ink, fontWeight: '700', flex: 1, textAlign: 'center' }, action: { ...typography.body, color: palette.accent }, body: { padding: 18, gap: 22 }, field: { gap: 9 }, label: { ...typography.label, color: palette.ink, fontWeight: '600' },
  intervalRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, number: { width: 66, borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12, textAlign: 'center', fontVariant: ['tabular-nums'] }, units: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  weekdays: { flexDirection: 'row', gap: 3 }, weekday: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 9 }, weekdayText: { ...typography.body, color: palette.muted }, selected: { backgroundColor: palette.accentSoft, borderColor: palette.accent }, selectedText: { color: palette.accent, fontWeight: '700' },
  select: { flex: 1, minHeight: 46, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12 }, value: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted }, error: { ...typography.body, color: palette.warning },
  preview: { gap: 5, paddingTop: 15, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, previewLabel: { ...typography.caption, color: palette.muted }, previewText: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
});
