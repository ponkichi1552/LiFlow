import { Chevron } from '../../components/chevron';
import { FormTextInput as TextInput } from '../../components/form-text-input';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { NumberInputField } from '@/components/number-input-field';

import { AppButton, Card, ChoiceChip, SectionHeading, palette, typography } from '@/components/planner-ui';
import { addDays, daysBetween, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
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
    <Card>
      <SectionHeading title={initial ? '収集日を編集' : '収集日を追加'} />
      <TextInput accessibilityLabel="ゴミの種類" value={query} editable={!locked}
        onChangeText={(value) => { update({ query: value, label: null }); setError(null); }} maxLength={80}
        placeholder="ゴミの種類（例：可燃ゴミ）" placeholderTextColor={palette.muted} style={styles.input} returnKeyType="done" />
      {label ? (
        <View style={[styles.selection, { borderColor: wasteTypeColor(label) }]}><Text style={[styles.selectionText, { color: wasteTypeColor(label) }]}>{label}</Text><AppButton title="選び直す" onPress={() => update({ label: null })} variant="quiet" compact disabled={locked} /></View>
      ) : query.trim() ? (
        <View style={styles.suggestions}>
          <Text style={styles.label}>候補を選択</Text>
          {candidates.map((candidate) => <Pressable key={candidate.label} accessibilityRole="button" accessibilityLabel={`${candidate.label}を選択`} disabled={locked}
            onPress={() => update({ query: candidate.label, label: candidate.label })} style={styles.candidate}>
            <Text style={[styles.candidateText, { color: wasteTypeColor(candidate.label) }]}>{candidate.label}</Text><Chevron />
          </Pressable>)}
          {!candidates.length ? <Pressable accessibilityRole="button" disabled={locked} onPress={() => update({ query: query.trim(), label: query.trim() })} style={styles.candidate}>
            <Text style={styles.candidateText}>「{query.trim()}」を使う</Text><Chevron />
          </Pressable> : null}
        </View>
      ) : null}
      <Text style={styles.body}>ひらがな・カタカナでも検索できます。自治体の収集区分に合わせて選んでください。</Text>
      <Text style={styles.label}>収集周期</Text>
      <View style={styles.chips}>
        {([['weekly', '毎週'], ['biweekly', '隔週'], ['monthly', '毎月']] as const).map(([id, name]) => (
          <ChoiceChip key={id} label={name} selected={recurrence === id} onPress={() => { if (!locked) changeRecurrence(id); }} />
        ))}
      </View>
      {recurrence === 'monthly' ? (
        <>
          <View style={styles.monthlyRow}><Text style={styles.label}>毎月の収集日</Text>
            <NumberInputField accessibilityLabel="毎月の収集日" value={monthlyDay} editable={!locked} onChangeText={value => update({ monthlyDay: value })} maxLength={2} />
          </View>
          <Text style={styles.body}>指定した日がない月は、月末に表示します。</Text>
        </>
      ) : (
        <>
          <Text style={styles.label}>{recurrence === 'biweekly' ? '隔週の曜日（1つ）' : '収集曜日'}</Text>
          <View style={styles.weekdays}>
            {wasteWeekdays.map((day) => <Pressable key={day.id} accessibilityRole="button" accessibilityLabel={`${day.label}曜`}
              accessibilityState={{ selected: weekdays.includes(day.id), disabled: locked }} disabled={locked}
              onPress={() => toggleWeekday(day.id)} style={[styles.weekday, weekdays.includes(day.id) && styles.weekdaySelected]}>
              <Text style={[styles.weekdayText, weekdays.includes(day.id) && styles.weekdaySelectedText]}>{day.label}</Text>
            </Pressable>)}
          </View>
        </>
      )}
      {recurrence === 'biweekly' && nextDate ? (
        <>
          <Text style={styles.label}>次に収集する週</Text>
          <View style={styles.chips}>{[nextDate, addDays(nextDate, 7)].map((date) => <ChoiceChip key={date}
            label={formatJapaneseDate(date, { weekday: true })} selected={Boolean(anchorDate && daysBetween(anchorDate, date) % 14 === 0)}
            onPress={() => { if (!locked) update({ anchorDate: date }); }} />)}</View>
          <Text style={styles.body}>選んだ日を基準に、2週間ごとに表示します。</Text>
        </>
      ) : null}
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <AppButton title={saving ? '保存中…' : initial ? '変更を保存' : '収集日を追加'} onPress={() => void save()} disabled={locked || !canSave} />
      {onCancel ? <AppButton title="編集をやめる" onPress={onCancel} variant="quiet" compact disabled={locked} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  input: { ...typography.body, minHeight: 54, borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, color: palette.ink, backgroundColor: palette.background },
  label: { ...typography.label, color: palette.ink, fontWeight: '700' },
  body: { ...typography.caption, color: palette.muted },
  error: { ...typography.label, color: palette.warning },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  weekdays: { flexDirection: 'row', gap: 5 },
  weekday: { flex: 1, minHeight: 44, borderWidth: 1, borderColor: palette.border, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  weekdaySelected: { backgroundColor: palette.accentSoft, borderColor: palette.accent },
  weekdayText: { ...typography.label, color: palette.muted, fontWeight: '700' },
  weekdaySelectedText: { color: palette.accent },
  monthlyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selection: { borderRadius: 13, borderWidth: 1.5, backgroundColor: palette.surface, paddingHorizontal: 13, minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectionText: { ...typography.body, flex: 1, color: palette.ink, fontWeight: '700' },
  suggestions: { gap: 8 },
  candidate: { minHeight: 46, borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  candidateText: { ...typography.label, color: palette.ink, flex: 1, fontWeight: '600' },
  arrow: { color: palette.accent, fontSize: 23, lineHeight: 25 },
});
