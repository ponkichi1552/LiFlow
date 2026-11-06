import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppButton, ChoiceChip, SectionHeading, palette, typography } from '../../components/planner-ui';
import { NumberInputField } from '../../components/number-input-field';
import { CalendarField } from '../calendar/calendar-field';
import { useV2DraftLifecycle } from '../sharing/v2-ui/use-draft-lifecycle';
import { createPersonalCapacityEditor } from './personal-capacity-editor';
import type { PersonalCapacitySource } from './personal-capacity-editor';
import type { LocalDate } from '../../domain/shared/types';
import { addDays } from '../../domain/scheduling/local-date';

export function PersonalCapacitySettings({ load, today, onDraftChange, onBlocked, children = content => content }: { load(): Promise<PersonalCapacitySource>; today: LocalDate; onDraftChange(value: boolean): void;
  onBlocked?(): void;
  children?(content: ReactNode): ReactNode }) {
  const [source, setSource] = useState<PersonalCapacitySource | null>(null); const [failed, setFailed] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; void load().then(value => { if (live) { setSource(value); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [load, attempt]);
  if (source) return <CapacityForm source={source} today={today} onDraftChange={onDraftChange} onBlocked={onBlocked} render={children} />;
  return children(failed ? <View><Text accessibilityRole="alert" style={styles.error}>日別設定を読み込めませんでした。</Text>
    <AppButton title="再読込" compact variant="quiet" onPress={() => setAttempt(value => value + 1)} /></View> : <Text style={typography.caption}>日別設定を読み込み中…</Text>);
}

function CapacityForm({ source, today, onDraftChange, onBlocked, render }: { source: PersonalCapacitySource; today: LocalDate; onDraftChange(value: boolean): void; onBlocked?(): void; render(content: ReactNode): ReactNode }) {
  const [editor] = useState(() => createPersonalCapacityEditor(source)); const { snapshot } = useV2DraftLifecycle(editor);
  const unsettled = snapshot.hasDraft || ['pending', 'saving', 'error'].includes(snapshot.status.phase);
  useEffect(() => { onDraftChange(unsettled); return () => onDraftChange(false); }, [onDraftChange, unsettled]);
  useEffect(() => { if (snapshot.navigationBlocked) onBlocked?.(); }, [snapshot.navigationBlocked, onBlocked]);
  const raw = snapshot.raw;
  return render(<View style={styles.section}>
    <View style={styles.row}><Text style={typography.label}>家事の時間上限</Text><NumberInputField accessibilityLabel="1日の家事時間上限" suffix="分" placeholder="上限なし" value={raw.maximum}
      onChangeText={maximum => editor.change(value => ({ ...value, maximum }))} onBlur={() => { void editor.flush(); }} maxLength={7} /></View>
    <SectionHeading title="日別の休日" level="subsection" />
    {raw.days.map(day => <View key={day.id} style={styles.date}>
      <View style={styles.row}><CalendarField hideLabel label="休日の日付" mode="date" date={day.date} minute={0} onDate={date => editor.change(value => ({ ...value,
        days: value.days.map(row => row.id === day.id ? { ...row, date } : row) }))} />
        <AppButton title="削除" compact variant="quiet" onPress={() => editor.change(value => ({ ...value, days: value.days.filter(row => row.id !== day.id) }))} /></View>
      <View style={styles.row}>{[{ label: '休日', value: true }, { label: '勤務日', value: false }].map(choice => <ChoiceChip key={choice.label} label={choice.label}
        selected={day.holiday === choice.value} onPress={() => editor.change(value => ({ ...value,
          days: value.days.map(row => row.id === day.id ? { ...row, holiday: choice.value } : row) }))} />)}</View>
      <View style={styles.row}><Text style={typography.caption}>この日の上限</Text><NumberInputField accessibilityLabel={`${day.date}の家事時間上限`} suffix="分" placeholder="通常どおり" value={day.maximum}
        onChangeText={maximum => editor.change(value => ({ ...value, days: value.days.map(row => row.id === day.id ? { ...row, maximum } : row) }))}
        onBlur={() => { void editor.flush(); }} maxLength={7} /></View>
    </View>)}
    <AppButton title="日付を追加" compact variant="quiet" onPress={() => {
      let date = today; const occupied = new Set(raw.days.map(day => day.date)); while (occupied.has(date)) date = addDays(date, 1); editor.addDate(date);
    }} />
    {snapshot.validation || snapshot.status.error ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.validation ?? snapshot.status.error}</Text> : null}
    {snapshot.status.phase === 'error' ? <AppButton title="保存を再試行" compact variant="quiet" onPress={() => { void editor.flush(); }} /> : null}
    {snapshot.navigationBlocked ? <AppButton title="未保存の入力を破棄" compact variant="quiet" onPress={editor.discardDraft} /> : null}
  </View>);
}
const styles = StyleSheet.create({ section: { gap: 8 }, row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  date: { gap: 6, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, error: { ...typography.caption, color: palette.warning } });
