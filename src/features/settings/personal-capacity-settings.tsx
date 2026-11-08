import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { NumberInputField } from '../../components/number-input-field';
import { SettingsPanel } from '../../components/settings-controls';
import { CalendarField } from '../calendar/calendar-field';
import { useV2DraftLifecycle } from '../sharing/v2-ui/use-draft-lifecycle';
import { createPersonalCapacityEditor } from './personal-capacity-editor';
import type { PersonalCapacitySource } from './personal-capacity-editor';
import type { LocalDate, Weekday } from '../../domain/shared/types';
import type { DayType } from '../planner/day-type-capacity';
import { defaultDayTypeBands } from '../planner/day-type-capacity';
import { HolidayCalendar } from './holiday-calendar';
import { plannerColorsForScheme } from '../../components/planner-theme';

type CapacityProps = { load(): Promise<PersonalCapacitySource>; today: LocalDate; restDays?: readonly Weekday[];
  limits?: ReactNode; onDraftChange(value: boolean): void; onBlocked?(): void; children?(content: ReactNode): ReactNode };
export function PersonalCapacitySettings({ load, today, restDays = [], limits, onDraftChange, onBlocked, children = content => content }: CapacityProps) {
  const [source, setSource] = useState<PersonalCapacitySource | null>(null); const [failed, setFailed] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; void load().then(value => { if (live) { setSource(value); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [load, attempt]);
  if (source) return <CapacityForm source={source} today={today} restDays={restDays} limits={limits} onDraftChange={onDraftChange} onBlocked={onBlocked} render={children} />;
  return children(failed ? <View><Text accessibilityRole="alert" style={styles.error}>日別設定を読み込めませんでした。</Text>
    <AppButton title="再読込" compact variant="quiet" onPress={() => setAttempt(value => value + 1)} /></View> : <Text style={typography.caption}>日別設定を読み込み中…</Text>);
}

const kinds: readonly { id: DayType; label: string }[] = [{ id: 'workday', label: '平日' }, { id: 'holiday', label: '休日' }];
function CapacityForm({ source, today, restDays, limits, onDraftChange, onBlocked, render }: {
  source: PersonalCapacitySource; today: LocalDate; restDays: readonly Weekday[]; limits?: ReactNode;
  onDraftChange(value: boolean): void; onBlocked?(): void; render(content: ReactNode): ReactNode;
}) {
  const [editor] = useState(() => createPersonalCapacityEditor(source)); const { snapshot } = useV2DraftLifecycle(editor);
  const [selectedDate, selectDate] = useState<LocalDate | null>(null); const [dateLimit, showDateLimit] = useState(false);
  const unsettled = snapshot.hasDraft || ['pending', 'saving', 'error'].includes(snapshot.status.phase);
  useEffect(() => { onDraftChange(unsettled); return () => onDraftChange(false); }, [onDraftChange, unsettled]);
  useEffect(() => { if (snapshot.navigationBlocked) onBlocked?.(); }, [snapshot.navigationBlocked, onBlocked]);
  const raw = snapshot.raw; const selectedDay = raw.days.find(day => day.date === selectedDate);
  const colors = plannerColorsForScheme(useColorScheme());
  return render(<View style={styles.section}>
    <Text style={styles.heading}>1日の上限</Text>
    <SettingsPanel>{limits}{kinds.map(kind => <View key={kind.id} style={[styles.row, { borderTopColor: colors.border }]}>
      <Text style={styles.label}>{kind.label}の家事合計時間</Text>
      <NumberInputField accessibilityLabel={`${kind.label}の家事時間上限`} suffix={(raw.dayTypes?.[kind.id].maximum ?? raw.maximum).trim() ? '分' : ''} inputWidth={68} placeholder="上限なし"
        value={raw.dayTypes?.[kind.id].maximum ?? raw.maximum} onChangeText={value => editor.setMaximum(kind.id, value)}
        onBlur={() => { void editor.flush(); }} maxLength={7} borderless />
    </View>)}</SettingsPanel>
    <Text style={styles.heading}>実施できる時間帯</Text>
    <SettingsPanel>{kinds.map(kind => {
      const configured = raw.dayTypes?.[kind.id].bands;
      const bands = configured === undefined ? defaultDayTypeBands(kind.id).map(band => ({ ...band, id: undefined }))
        : configured.length ? configured : [{ id: undefined, startMinute: null, endMinute: null }];
      return <View key={kind.id} style={[styles.timeSection, { borderTopColor: colors.border }]}>
        <View style={styles.timeHeading}><Text style={styles.label}>{kind.label}</Text></View>
        {bands.map((band, index) => <View key={index === 0 ? 'first' : band.id} style={styles.timeRow}>
          <CalendarField hideLabel label={`${kind.label}の開始時刻${index ? index + 1 : ''}`} mode="time" date={today} minute={band.startMinute ?? defaultDayTypeBands(kind.id)[0].startMinute}
            displayValue={band.startMinute == null ? '開始' : undefined} onMinute={minute => editor.setBandTime(kind.id, band.id, 'startMinute', minute,
              band.startMinute !== null && band.endMinute !== null ? { startMinute: band.startMinute, endMinute: band.endMinute } : undefined)} />
          <Text style={styles.hint}>〜</Text>
          <CalendarField hideLabel label={`${kind.label}の終了時刻${index ? index + 1 : ''}`} mode="time" date={today} minute={band.endMinute ?? defaultDayTypeBands(kind.id)[0].endMinute}
            displayValue={band.endMinute == null ? '終了' : undefined} onMinute={minute => editor.setBandTime(kind.id, band.id, 'endMinute', minute === 0 ? 1440 : minute,
              band.startMinute !== null && band.endMinute !== null ? { startMinute: band.startMinute, endMinute: band.endMinute } : undefined)} />
        </View>)}
        {configured === undefined && raw.allowedBands.length > 0 ? <Text style={styles.hint}>設定済みの曜日別時間帯を使用中</Text> : null}
      </View>;
    })}</SettingsPanel>
    <Text accessibilityRole="header" style={styles.heading}>カレンダーで休日を登録</Text>
    <View style={styles.dateSection}>
      <HolidayCalendar today={today} restDays={restDays} days={raw.days} onToggle={date => {
        selectDate(date); showDateLimit(Boolean(raw.days.find(day => day.date === date)?.maximum)); editor.toggleHoliday(date, restDays);
      }} />
      {selectedDate ? <View>
        <Pressable accessibilityRole="button" accessibilityLabel="選択日の時間上限を変更" accessibilityState={{ expanded: dateLimit }} onPress={() => showDateLimit(value => !value)} style={styles.disclosure}>
          <Text style={styles.actionText}>{Number(selectedDate.slice(5, 7))}/{Number(selectedDate.slice(8, 10))}の時間上限</Text><Chevron direction={dateLimit ? 'up' : 'down'} />
        </Pressable>
        {dateLimit ? <View style={styles.dateLimit}><Text style={styles.label}>家事合計時間</Text><NumberInputField accessibilityLabel={`${selectedDate}の家事時間上限`} suffix="分" inputWidth={96} placeholder="通常どおり" value={selectedDay?.maximum ?? ''}
          onChangeText={maximum => editor.setDateMaximum(selectedDate, maximum)} onBlur={() => { void editor.flush(); }} maxLength={7} /></View> : null}
        {selectedDay ? <AppButton title="この日の変更を解除" compact variant="quiet" onPress={() => editor.change(value => ({ ...value, days: value.days.filter(day => day.date !== selectedDate) }))} /> : null}
      </View> : null}
    </View>
    {snapshot.validation || snapshot.status.error ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.validation ?? snapshot.status.error}</Text> : null}
    {snapshot.status.phase === 'error' ? <AppButton title="保存を再試行" compact variant="quiet" onPress={() => { void editor.flush(); }} /> : null}
  </View>);
}
const styles = StyleSheet.create({
  section: { gap: 12 }, heading: { ...typography.label, color: palette.ink, fontWeight: '600' }, label: { ...typography.label, color: palette.ink },
  row: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTopWidth: 1, borderTopColor: palette.border },
  timeSection: { paddingVertical: 10, gap: 6, borderTopWidth: 1, borderTopColor: palette.border },
  timeHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, actionText: { ...typography.control, color: palette.accent },
  hint: { ...typography.caption, color: palette.muted }, disclosure: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  dateSection: { gap: 8 }, dateLimit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  error: { ...typography.caption, color: palette.warning },
});
