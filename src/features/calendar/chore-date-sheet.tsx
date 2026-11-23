import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { typography } from '../../components/planner-ui';
import { SettingsAction } from '../../components/settings-controls';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarSheetHeader } from './calendar-sheet-header';
import { ChoreDateFields } from './chore-date-fields';
import { addDays, formatJapaneseDate } from '../../domain/scheduling/local-date';
import { choreCalendarTiming, type ChoreCalendarTiming } from '../../domain/chores/calendar-timing';
import { minuteLabel, newEventDraft, type EventDraft } from './events';
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
  const [readAttempt, setReadAttempt] = useState(0);
  const [readState, setReadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [reviewDate, setReviewDate] = useState(false);
  const retryInput = useRef<{ date: LocalDate | null } | null>(null);
  const operation = useRef<{ digest: string; operationId: string; recordedAt: string } | null>(null);
  const entry = data.snapshot?.scheduleEntries.find(row => row.choreId === params.choreId && row.id === params.entryId);
  useEffect(() => {
    let live = true;
    const kept = capturedDatabase.current === data.database ? retryInput.current : null;
    void readPersonalChoreDate(data.database, params.choreId, params.entryId).then(value => {
      if (!live) return;
      if (!kept) { setDate(null); setTimed(null); }
      if (!value.roundId || value.roundId !== params.entryId) {
        setCaptured(null); setReadState('failed'); setError('この家事回は更新されました。カレンダーをご確認ください。'); return;
      }
      capturedDatabase.current = data.database; setCaptured(value); setError(null); setReviewDate(Boolean(kept)); setReadState('ready');
      if (value.calendarTiming && !value.calendarTiming.allDay && value.date) {
        const latest = { ...newEventDraft(value.date, value.calendarTiming.timeZone),
        allDay: false, startMinute: value.calendarTiming.startMinute, endMinute: value.calendarTiming.endMinute,
          endDate: addDays(value.date, value.calendarTiming.endDayOffset) };
        setTimed(current => kept && current ? current : kept?.date ? moveCalendarStart(latest, { startDate: kept.date }) : latest);
      }
    }).catch(cause => {
      if (live) { setReadState('failed'); setError(cause instanceof Error ? cause.message : '家事を読み込めませんでした。'); }
    });
    return () => { live = false; };
  }, [data.database, params.choreId, params.entryId, readAttempt]);
  const selected = timed?.startDate ?? date ?? captured?.date ?? entry?.suggestedDate;
  const displayTimeZone = data.snapshot?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let validation: string | null = null;
  let timing: ChoreCalendarTiming | undefined;
  if (timed) { try { timing = choreCalendarTiming(timed); } catch (cause) { validation = cause instanceof Error ? cause.message : '開始・終了を確認してください。'; } }
  const originalTiming = captured?.calendarTiming;
  const changed = selected !== (captured?.date ?? entry?.suggestedDate) || Boolean(timing &&
    (timing.startMinute !== originalTiming?.startMinute || timing.endMinute !== originalTiming?.endMinute
      || timing.endDayOffset !== originalTiming?.endDayOffset));
  const canSave = readState === 'ready' && !validation && changed && captured && selected && entry;
  const fieldDisabled = busy || readState === 'loading' || !captured;
  const reload = () => {
    if (lock.current || readState === 'loading') return;
    retryInput.current = captured ? changed ? { date } : null : retryInput.current;
    setReadState('loading'); setError(null); setReadAttempt(attempt => attempt + 1);
  };
  const save = async () => {
    if (lock.current || !canSave || !captured?.roundId || !captured.planRevision || !selected
      || captured.definition.id !== params.choreId || captured.roundId !== params.entryId || capturedDatabase.current !== data.database) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const command = { choreId: params.choreId, roundId: captured.roundId, planRevision: captured.planRevision, definition: captured.signature,
        date: selected, ...(timing ? { timing } : {}) };
      const digest = JSON.stringify(command);
      if (operation.current?.digest !== digest) operation.current = { digest, operationId: newCalendarSubmissionId(), recordedAt: new Date().toISOString() };
      await movePersonalChoreDate(data.database, { operationId: operation.current.operationId, recordedAt: operation.current.recordedAt, ...command });
      void data.refresh(); router.back();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日付を保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <View collapsable={false} style={{ backgroundColor: colors.surface }}>
    <Stack.Screen options={{ gestureEnabled: !busy }} />
    <View style={styles.header}><CalendarSheetHeader title={timed ? '日時を変更' : '実施日を変更'} onClose={() => router.back()} closeLabel="家事の日付変更を閉じる"
      onSave={() => void save()} saveLabel={timed ? '今回の日時を保存' : '今回の実施日を保存'} busy={busy} saveDisabled={!canSave} /></View>
    <ScrollView style={styles.body} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.name, { color: colors.ink }]}>{captured?.definition.name ?? data.snapshot?.chores.find(row => row.id === params.choreId)?.name ?? '家事'}</Text>
      {readState === 'loading' ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.muted }]}>家事を読み込み中…</Text> : null}
      {readState === 'ready' && reviewDate && captured?.date ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.muted }]}>現在の実施日 {formatJapaneseDate(captured.date)}{captured.calendarTiming && !captured.calendarTiming.allDay ? ` ${minuteLabel(captured.calendarTiming.startMinute)}〜${minuteLabel(captured.calendarTiming.endMinute)}` : ''}</Text> : null}
      <ChoreDateFields date={selected} timed={timed} displayTimeZone={displayTimeZone} disabled={fieldDisabled} onDateChange={setDate}
        onTimedChange={update => setTimed(before => before && update(before))} />
      {validation || error || data.error ? <Text accessibilityRole="alert" style={[styles.message, { color: colors.warning }]}>{validation ?? error ?? data.error}</Text> : null}
      {error && readState !== 'loading' ? <SettingsAction placement="page" title="現在の家事を再読込" disabled={busy} onPress={reload} /> : null}
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
  header: { paddingTop: 20 }, body: { flexGrow: 0 }, content: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 16, gap: 8 },
  name: { ...typography.subheading, fontWeight: '600' }, message: { ...typography.caption },
});
