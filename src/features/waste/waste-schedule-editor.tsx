import { Chevron } from '../../components/chevron';
import { FormTextInput as TextInput } from '../../components/form-text-input';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { NumberInputField } from '@/components/number-input-field';

import { AppButton, ChoiceChip, palette, typography } from '@/components/planner-ui';
import { SettingsPanel, SettingsSegments, SettingsAction } from '../../components/settings-controls';
import { CalendarDayPicker } from '../../components/calendar-day-picker';
import { WasteTypeIcon } from '../../components/waste-type-icon';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { addDays, daysBetween, formatJapaneseDate, localDateFromDate, parseLocalDate } from '@/domain/scheduling/local-date';
import type { LocalDate, Weekday } from '@/domain/shared/types';
import type { WasteRecurrence, WasteScheduleInput } from './contracts';
import { nextWasteWeekday, normalizeWasteSchedule, wasteWeekdays } from './schedule-policy';
import { searchWasteTypes } from './waste-types';
import { useWasteTypeColor } from './use-waste-type-color';

/** The same editor is used in first-run setup and settings so the supported modes cannot drift. */
export function WasteScheduleEditor({ initial, onSubmit, onCancel, disabled = false, referenceDate }: {
  initial?: WasteScheduleInput;
  onSubmit: (schedule: WasteScheduleInput) => Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  referenceDate?: LocalDate;
}) {
  const wasteTypeColor = useWasteTypeColor();
  const colors = plannerColorsForScheme(useColorScheme());

  const today = referenceDate ?? localDateFromDate(new Date());
  const [form, setForm] = useState(() => ({ query: initial?.label ?? '', label: initial?.label ?? null as string | null,
    recurrence: initial?.recurrence ?? 'weekly' as WasteRecurrence, weekdays: [...(initial?.collectionWeekdays ?? [])] as Weekday[],
    anchorDate: initial?.anchorDate, monthlyDay: String(initial?.monthlyDay ?? Number(today.slice(-2))) }));
  const draft = useRef(form);
  // Event handlers can run before React paints the preceding input event.
  const update = (patch: Partial<typeof form>) => { draft.current = { ...draft.current, ...patch }; setForm(draft.current); };
  const { query, label, recurrence, weekdays, anchorDate, monthlyDay } = form;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = label ? [] : searchWasteTypes(query);
  const locked = disabled || saving;
  const nextDate = weekdays[0] ? nextWasteWeekday(today, weekdays[0]) : undefined;
  const validMonthlyDay = /^\d{1,2}$/.test(monthlyDay) && Number(monthlyDay) >= 1 && Number(monthlyDay) <= 31;
  const canSave = Boolean(label && (recurrence === 'monthly' ? validMonthlyDay : weekdays.length && (recurrence !== 'biweekly' || anchorDate)));

  const changeRecurrence = (value: WasteRecurrence) => {
    const current = draft.current;
    if (locked || value === current.recurrence) return;
    setError(null);
    if (value === 'biweekly') {
      update({ recurrence: value, weekdays: current.weekdays.slice(0, 1), anchorDate: current.weekdays[0] ? nextWasteWeekday(today, current.weekdays[0]) : undefined });
    } else update({ recurrence: value, anchorDate: value === 'monthly' ? today : undefined });
  };
  const toggleWeekday = (day: Weekday) => {
    if (locked) return;
    const current = draft.current;
    if (current.recurrence === 'biweekly') {
      const remove = current.weekdays.includes(day);
      update({ weekdays: remove ? [] : [day], anchorDate: remove ? undefined : nextWasteWeekday(today, day) });
    } else update({ weekdays: current.weekdays.includes(day) ? current.weekdays.filter(item => item !== day) : [...current.weekdays, day].sort() });
  };
  const save = async () => {
    const current = draft.current;
    if (locked || savingRef.current || !current.label) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (current.recurrence === 'monthly' && !/^\d{1,2}$/.test(current.monthlyDay)) throw new RangeError('毎月の収集日を1〜31日の整数で入力してください');
      await onSubmit(normalizeWasteSchedule({ id: initial?.id, label: current.label, collectionWeekdays: current.weekdays, recurrence: current.recurrence,
        anchorDate: current.anchorDate, ...(current.recurrence === 'monthly' ? { monthlyDay: Number(current.monthlyDay) } : {}) }));
      update({ query: '', label: null, weekdays: [], recurrence: 'weekly', anchorDate: undefined, monthlyDay: String(Number(today.slice(-2))) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '収集日を保存できませんでした。');
    } finally { savingRef.current = false; setSaving(false); }
  };

  return (
    <View style={styles.editor}>
      {initial ? <Text style={[styles.label, { color: colors.ink }]}>収集日を編集</Text> : null}
      <SettingsPanel><View style={styles.fields}>
      <View style={[styles.inputShell, { borderColor: colors.inputBorder, backgroundColor: colors.surface }]}>
        <WasteTypeIcon label={label ?? 'その他'} size={20} color={label ? wasteTypeColor(label) : colors.muted} />
        <TextInput accessibilityLabel="ゴミの種類" value={query} editable={!locked}
        onChangeText={(value) => { update({ query: value, label: null }); setError(null); }} maxLength={80}
        placeholder="ゴミの種類を検索" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.ink }]} returnKeyType="done" />
      </View>
      {!label && query.trim() ? (
        <View style={styles.suggestions}>
          {candidates.map((candidate) => <Pressable key={candidate.label} accessibilityRole="button" accessibilityLabel={`${candidate.label}を選択`} disabled={locked}
            onPress={() => update({ query: candidate.label, label: candidate.label })} style={[styles.candidate, { borderBottomColor: colors.border }]}>
            <WasteTypeIcon label={candidate.label} size={20} /><Text style={[styles.candidateText, { color: wasteTypeColor(candidate.label) }]}>{candidate.label}</Text><Chevron color={colors.accent} />
          </Pressable>)}
          {!candidates.length ? <Pressable accessibilityRole="button" disabled={locked} onPress={() => update({ query: query.trim(), label: query.trim() })} style={[styles.candidate, { borderBottomColor: colors.border }]}>
            <Text style={[styles.candidateText, { color: colors.ink }]}>「{query.trim()}」を使う</Text><Chevron color={colors.accent} />
          </Pressable> : null}
        </View>
      ) : null}
      <View style={[styles.row, { borderTopColor: colors.border }]}><Text style={[styles.label, { color: colors.ink }]}>繰り返し</Text>
        <SettingsSegments options={[{ id: 'weekly', label: '毎週' }, { id: 'biweekly', label: '隔週' }, { id: 'monthly', label: '毎月' }] as const}
          value={recurrence} onValueChange={changeRecurrence} disabled={locked} />
      </View>
      {recurrence === 'monthly' ? (
        <>
          <View style={[styles.row, { borderTopColor: colors.border }]}><Text style={[styles.label, { color: colors.ink }]}>毎月の収集日</Text>
            <NumberInputField accessibilityLabel="毎月の収集日" value={monthlyDay} editable={!locked} onChangeText={value => update({ monthlyDay: value })} maxLength={2} inputWidth={24} borderless />
          </View>
          <CalendarDayPicker today={today} label="収集日カレンダー" disabled={locked} selected={date => {
            if (!validMonthlyDay) return false;
            const parsed = parseLocalDate(date); const last = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
            return Number(date.slice(8, 10)) === Math.min(Number(monthlyDay), last);
          }} onSelect={date => { if (!locked) update({ monthlyDay: String(Number(date.slice(8, 10))) }); }} />
          {Number(monthlyDay) > 28 ? <Text style={[styles.body, { color: colors.muted }]}>指定日がない月は月末に表示</Text> : null}
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: colors.ink }]}>{recurrence === 'biweekly' ? '隔週の曜日（1つ）' : '収集曜日'}</Text>
          <View style={styles.weekdays}>
            {wasteWeekdays.map((day) => <Pressable key={day.id} accessibilityRole="button" accessibilityLabel={`${day.label}曜`}
              accessibilityState={{ selected: weekdays.includes(day.id), disabled: locked }} disabled={locked}
              onPress={() => toggleWeekday(day.id)} style={[styles.weekday, { borderColor: weekdays.includes(day.id) ? colors.accent : colors.border,
                backgroundColor: weekdays.includes(day.id) ? colors.accentSoft : colors.surface }]}>
              <Text style={[styles.weekdayText, { color: weekdays.includes(day.id) ? colors.accent : colors.muted }]}>{day.label}</Text>
            </Pressable>)}
          </View>
        </>
      )}
      {recurrence === 'biweekly' && nextDate ? (
        <>
          <Text style={[styles.label, { color: colors.ink }]}>次の収集日</Text>
          <View style={styles.chips}>{[nextDate, addDays(nextDate, 7)].map((date) => <ChoiceChip key={date}
            label={formatJapaneseDate(date, { weekday: true })} selected={Boolean(anchorDate && daysBetween(anchorDate, date) % 14 === 0)}
            onPress={() => { if (!locked) update({ anchorDate: date }); }} />)}</View>
        </>
      ) : null}
      </View></SettingsPanel>
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <AppButton title={saving ? '保存中…' : initial ? '変更を保存' : '収集日を追加'} onPress={() => void save()} disabled={locked || !canSave} />
      {onCancel ? <SettingsAction title="編集をやめる" onPress={onCancel} placement="page" disabled={locked} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { gap: 12 }, fields: { gap: 10, paddingVertical: 12 },
  inputShell: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12 },
  input: { ...typography.control, flex: 1, minWidth: 0, minHeight: 46, padding: 0, textAlignVertical: 'center', includeFontPadding: false },
  label: { ...typography.label, fontWeight: '500' },
  body: { ...typography.caption, color: palette.muted },
  error: { ...typography.label, color: palette.warning },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  weekdays: { flexDirection: 'row', gap: 5 },
  weekday: { flex: 1, minHeight: 44, borderWidth: 1, borderColor: palette.border, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  weekdayText: { ...typography.label, color: palette.muted, fontWeight: '700' },
  row: { minHeight: 56, borderTopWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 8 },
  suggestions: { gap: 0 },
  candidate: { minHeight: 46, borderBottomWidth: 1, paddingHorizontal: 6, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  candidateText: { ...typography.label, color: palette.ink, flex: 1, fontWeight: '600' },
});
