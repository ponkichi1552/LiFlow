import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { typography } from '../../components/planner-ui';
import { SettingsPanel } from '../../components/settings-controls';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarField } from './calendar-field';
import { CalendarSheetHeader } from './calendar-sheet-header';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date';
import { choreCalendarTiming } from '../../domain/chores/calendar-timing';
import { newEventDraft, type EventDraft } from './events';
import { moveCalendarStart } from './event-editing';
import { newCalendarSubmissionId } from '../../platform/storage/calendar-events';
import { movePersonalChoreDate, readPersonalChoreDate } from '../../platform/storage/repository';
import { usePlannerData } from '../../hooks/use-planner-data';
import type { LocalDate } from '../../domain/shared/types';

export default function CalendarChoreDateSheet() {
  const params = useLocalSearchParams<{ choreId: string; entryId: string }>();
  return <ChoreDateEditor key={`${params.choreId}:${params.entryId}`} params={params} />;
}
function ChoreDateEditor({ params }: { params: { choreId: string; entryId: string } }) {
  const data = usePlannerData({ personal: true }); const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme);
  const [captured, setCaptured] = useState<Awaited<ReturnType<typeof readPersonalChoreDate>> | null>(null);
  const [date, setDate] = useState<LocalDate | null>(null); const [error, setError] = useState<string | null>(null);
  const [timed, setTimed] = useState<EventDraft | null>(null); const capturedDatabase = useRef(data.database);
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [operation] = useState(() => ({ operationId: newCalendarSubmissionId(), recordedAt: new Date().toISOString() }));
  const entry = data.snapshot?.scheduleEntries.find(row => row.choreId === params.choreId && row.id === params.entryId);
  useEffect(() => {
    let live = true;
    void readPersonalChoreDate(data.database, params.choreId, params.entryId).then(value => {
      if (!live) return;
      if (!value.roundId || value.roundId !== params.entryId) { setError('この回の予定は更新されています。元の画面で開き直してください。'); return; }
      capturedDatabase.current = data.database; setCaptured(value); setDate(null); setTimed(null); setError(null);
      if (value.calendarTiming && !value.calendarTiming.allDay && value.date) setTimed({ ...newEventDraft(value.date, value.calendarTiming.timeZone),
        allDay: false, startMinute: value.calendarTiming.startMinute, endMinute: value.calendarTiming.endMinute,
        endDate: addDays(value.date, value.calendarTiming.endDayOffset) });
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : '家事を読み込めませんでした。'); });
    return () => { live = false; };
  }, [data.database, params.choreId, params.entryId]);
  const selected = timed?.startDate ?? date ?? captured?.date ?? entry?.suggestedDate;
  const displayTimeZone = data.snapshot?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let validation: string | null = null;
  if (timed) { try { choreCalendarTiming(timed); } catch (cause) { validation = cause instanceof Error ? cause.message : '開始・終了を確認してください。'; } }
  const save = async () => {
    if (lock.current || !captured?.roundId || !captured.planRevision || !selected || validation
      || captured.definition.id !== params.choreId || captured.roundId !== params.entryId || capturedDatabase.current !== data.database) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await movePersonalChoreDate(data.database, { ...operation, choreId: params.choreId, roundId: captured.roundId, planRevision: captured.planRevision, definition: captured.signature, date: selected,
        ...(timed ? { timing: choreCalendarTiming(timed) } : {}) });
      void data.refresh(); router.back();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日付を保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <View collapsable={false} style={{ backgroundColor: colors.surface }}>
    <Stack.Screen options={{ gestureEnabled: !busy }} />
    <View style={styles.header}><CalendarSheetHeader title={timed ? '日時を変更' : '実施日を変更'} onClose={() => router.back()} closeLabel="家事の日付変更を閉じる"
      onSave={() => void save()} saveLabel={timed ? '今回の日時を保存' : '今回の実施日を保存'} busy={busy} saveDisabled={!captured || !selected || !entry || Boolean(validation)} /></View>
    <ScrollView style={styles.body} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.name, { color: colors.ink }]}>{captured?.definition.name ?? data.snapshot?.chores.find(row => row.id === params.choreId)?.name ?? '家事'}</Text>
      {timed ? <SettingsPanel>
        <View style={styles.dateFields}>
        <View style={styles.dateRow}><Text style={[typography.body, { color: colors.ink }]}>開始</Text>
          <CalendarField borderless hideLabel commitOnDone label="開始日" date={timed.startDate} minute={0} mode="date" disabled={busy} onDate={startDate => setTimed(before => before && moveCalendarStart(before, { startDate }))} />
          <View style={styles.timeField}><CalendarField borderless hideLabel commitOnDone label="開始時刻" date={timed.startDate} minute={timed.startMinute} mode="time" disabled={busy} onMinute={startMinute => setTimed(before => before && moveCalendarStart(before, { startMinute }))} /></View>
        </View>
        <View style={styles.dateRow}><Text style={[typography.body, { color: colors.ink }]}>終了</Text>
          <CalendarField borderless hideLabel commitOnDone label="終了日" date={timed.endDate} minute={0} mode="date" disabled={busy} onDate={endDate => setTimed(before => before && { ...before, endDate })} />
          <View style={styles.timeField}><CalendarField borderless hideLabel commitOnDone label="終了時刻" date={timed.endDate} minute={timed.endMinute} mode="time" disabled={busy} onMinute={endMinute => setTimed(before => before && { ...before, endMinute })} /></View>
        </View>
        </View>
        {timed.timeZone !== displayTimeZone ? <Text style={[styles.message, { color: colors.muted }]}>地域：{timed.timeZone}</Text> : null}
      </SettingsPanel> : selected ? Platform.OS === 'ios' ? <DateTimePicker accessibilityLabel="今回の実施日" value={parseLocalDate(selected)} mode="date" display="spinner" locale="ja-JP" timeZoneName="UTC"
        themeVariant={scheme === 'dark' ? 'dark' : 'light'} textColor={colors.ink} accentColor={colors.accent} disabled={busy} style={styles.picker}
        onValueChange={(_event, value) => { if (!busy && value && Number.isFinite(value.getTime())) setDate(value.toISOString().slice(0, 10) as LocalDate); }} />
        : <CalendarField label="今回の実施日" date={selected} minute={0} mode="date" disabled={busy} onDate={setDate} />
        : !error && !data.error ? <Text style={[styles.message, { color: colors.muted }]}>読み込み中…</Text> : null}
      {validation || error || data.error ? <Text accessibilityRole="alert" style={[styles.message, { color: colors.warning }]}>{validation ?? error ?? data.error}</Text> : null}
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
  header: { paddingTop: 20 }, body: { flexGrow: 0 }, content: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 16, gap: 8 },
  name: { ...typography.subheading, fontWeight: '600' }, picker: { alignSelf: 'center', maxWidth: '100%', height: 200 }, message: { ...typography.caption },
  dateFields: { gap: 8 }, dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, timeField: { width: 100, flexShrink: 0 },
});
