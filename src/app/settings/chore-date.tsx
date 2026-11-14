import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import { Page, typography } from '../../components/planner-ui';
import { SettingsHeader } from '../../components/settings-header';
import { SettingsPanel } from '../../components/settings-controls';
import { PlannerLoadState } from '../../components/planner-load-state';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarField } from '../../features/calendar/calendar-field';
import { newCalendarSubmissionId } from '../../platform/storage/calendar-events';
import { movePersonalChoreDate, readPersonalChoreDate } from '../../platform/storage/repository';
import { usePlannerData } from '../../hooks/use-planner-data';
import type { LocalDate } from '../../domain/shared/types';

export default function PersonalChoreDateRoute() {
  const params = useLocalSearchParams<{ choreId: string; entryId: string }>();
  const data = usePlannerData({ personal: true }); const colors = plannerColorsForScheme(useColorScheme());
  const [captured, setCaptured] = useState<Awaited<ReturnType<typeof readPersonalChoreDate>> | null>(null);
  const [date, setDate] = useState<LocalDate | null>(null); const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [operation] = useState(() => ({ operationId: newCalendarSubmissionId(), recordedAt: new Date().toISOString() }));
  const entry = data.snapshot?.scheduleEntries.find(row => row.choreId === params.choreId && row.id === params.entryId);
  useEffect(() => {
    let live = true;
    void readPersonalChoreDate(data.database, params.choreId, params.entryId).then(value => {
      if (!live) return;
      if (!value.roundId || value.roundId !== params.entryId) { setError('この回の予定は更新されています。元の画面で開き直してください。'); return; }
      setCaptured(value);
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : '家事を読み込めませんでした。'); });
    return () => { live = false; };
  }, [data.database, params.choreId, params.entryId]);
  const selected = date ?? entry?.suggestedDate;
  const save = async () => {
    if (lock.current || !captured?.roundId || !captured.planRevision || !selected) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await movePersonalChoreDate(data.database, { ...operation, choreId: params.choreId, roundId: captured.roundId, planRevision: captured.planRevision, definition: captured.signature, date: selected });
      void data.refresh(); router.back();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日付を保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!data.snapshot) return <PlannerLoadState title="家事の日付変更" message="家事を読み込んでいます。" error={data.error} retry={data.refresh} />;
  return <Page header={<SettingsHeader title="家事の日付変更" backDisabled={busy} action={{ title: '保存', accessibilityLabel: '今回の実施日を保存', onPress: () => void save(), disabled: busy || !captured || !selected || !entry }} />}>
    <Text style={{ ...typography.title, color: colors.ink }}>{captured?.definition.name ?? data.snapshot.chores.find(row => row.id === params.choreId)?.name ?? '家事'}</Text>
    {selected ? <SettingsPanel><View style={{ padding: 12 }}><CalendarField label="今回の実施日" date={selected} minute={0} mode="date" disabled={busy} onDate={setDate} borderless /></View></SettingsPanel> : null}
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning }}>{error}</Text> : null}
  </Page>;
}
