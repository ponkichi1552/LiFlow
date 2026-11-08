import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { AppButton, Page, palette, typography } from '@/components/planner-ui';
import { SettingsGroup } from '@/components/settings-controls';
import { WasteScheduleEditor } from '@/features/waste/waste-schedule-editor';
import { WasteRegistrationHeading, WasteSettingsAction, WasteSettingsHeading, WasteSettingsItem } from '@/features/waste/waste-settings-ui';
import { SettingsHeader } from '@/features/settings/settings-navigation';
import { WasteTypeIcon } from '@/components/waste-type-icon';
import { wasteScheduleDescription } from '@/features/waste/schedule-policy';
import { useWasteTypeColor } from '@/features/waste/use-waste-type-color';
import type { WasteScheduleInput } from '@/features/waste/contracts';
import { formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { deleteWeeklyWasteSchedule, restoreDeletedWasteSchedule, saveWeeklyWasteSchedule, setWasteOccurrenceHidden } from '@/platform/storage/repository';

export default function WasteScreen() {
  const wasteTypeColor = useWasteTypeColor();

  const { snapshot, error: loadError, refresh, database } = usePlannerData();
  const [editing, setEditing] = useState<WasteScheduleInput | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatingOccurrence, setUpdatingOccurrence] = useState(false);
  const mutationInFlight = useRef(false);
  const [undo, setUndo] = useState<{ label: string; action: () => Promise<void> } | null>(null);
  const busy = saving || updatingOccurrence;
  useEffect(() => {
    if (!undo || busy) return;
    const timer = setTimeout(() => setUndo(current => current === undo ? null : current), 6500);
    return () => clearTimeout(timer);
  }, [undo, busy]);

  if (!snapshot) return <PlannerLoadState title="ゴミ収集日" message="曜日設定を読み込んでいます。" error={loadError} retry={refresh} />;

  const save = async (schedule: WasteScheduleInput) => {
    if (mutationInFlight.current) throw new Error('別の変更を保存しています。完了後にもう一度お試しください。');
    mutationInFlight.current = true;
    setSaving(true);
    setMessage(null);
    setUndo(null);
    try {
      await saveWeeklyWasteSchedule(database, schedule, editing);
      setEditing(undefined);
      await refresh();
      setMessage('収集日を保存しました。');
    } finally { mutationInFlight.current = false; setSaving(false); }
  };

  const remove = async (scheduleId: string) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setSaving(true);
    setMessage(null);
    setUndo(null);
    try {
      const receipt = await deleteWeeklyWasteSchedule(database, scheduleId);
      if (receipt) setUndo({ label: receipt.label, action: () => restoreDeletedWasteSchedule(database, receipt.token) });
      if (editing?.id === scheduleId) setEditing(undefined);
      await refresh();
      setMessage('収集日を削除しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '収集日を削除できませんでした。');
    } finally {
      mutationInFlight.current = false;
      setSaving(false);
    }
  };

  const setOccurrenceHidden = async (scheduleId: string, date: `${number}-${number}-${number}`, hidden: boolean) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setUpdatingOccurrence(true);
    setMessage(null);
    setUndo(null);
    try {
      await setWasteOccurrenceHidden(database, scheduleId, date, hidden);
      const label = snapshot.wasteSchedules.find(schedule => schedule.id === scheduleId)?.label ?? '収集日';
      setUndo({ label, action: () => setWasteOccurrenceHidden(database, scheduleId, date, !hidden) });
      await refresh();
      setMessage(hidden ? 'この日の表示だけを非表示にしました。' : 'ゴミ予定を再表示しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'ゴミ予定を更新できませんでした。');
    } finally {
      mutationInFlight.current = false;
      setUpdatingOccurrence(false);
    }
  };

  const revert = async () => {
    if (mutationInFlight.current || !undo) return;
    mutationInFlight.current = true; setSaving(true); let committed = false;
    try {
      await undo.action(); committed = true; setUndo(null); await refresh(); setMessage('元に戻しました。');
    } catch (cause) { setMessage(committed ? '元に戻しました。表示を更新するには画面を開き直してください。' : cause instanceof Error ? cause.message : '元に戻せませんでした。'); }
    finally { mutationInFlight.current = false; setSaving(false); }
  };

  const nextSevenDays = snapshot.upcomingWasteDates
    .filter((occurrence) => occurrence.date >= (snapshot.today ?? localDateFromDate(new Date())))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 8);

  return (
    <Page header={<SettingsHeader title="ゴミ収集日" onBack={() => router.back()} />} contentStyle={styles.page} keyboardAware floatingFooter footer={undo ?
      <View style={styles.undo}><Text numberOfLines={1} style={[styles.body, { flex: 1 }]}>{undo.label}</Text>
        <AppButton title="元に戻す" accessibilityLabel={`${undo.label}を元に戻す`} compact variant="quiet" disabled={busy} onPress={() => void revert()} />
      </View> : undefined}>

      {loadError ? <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text> : null}

      <WasteScheduleEditor key={editing?.id ?? 'new'} initial={editing} referenceDate={snapshot.today} onSubmit={save} onCancel={editing ? () => setEditing(undefined) : undefined} disabled={busy} />
      {message ? <Text accessibilityLiveRegion="polite" style={message.includes('しました') ? styles.success : styles.error}>{message}</Text> : null}

      <WasteRegistrationHeading count={snapshot.wasteSchedules.length} />
      {snapshot.wasteSchedules.length > 0 ? <View>{snapshot.wasteSchedules.map((schedule) => (
        <WasteSettingsItem key={schedule.id}><View style={styles.scheduleCard}>
          <View style={styles.scheduleCopy}>
            <View style={styles.nameRow}><WasteTypeIcon label={schedule.label} size={20} /><Text style={[styles.scheduleName, { color: wasteTypeColor(schedule.label) }]}>{schedule.label}</Text></View>
            <Text style={styles.days}>{wasteScheduleDescription(schedule)}</Text>
          </View>
          <View style={styles.actions}>
            <WasteSettingsAction title="編集" accessibilityLabel={`「${schedule.label}」の収集日を編集`} onPress={() => { setEditing(schedule); setMessage(null); }} disabled={busy} />
            <WasteSettingsAction title="削除" accessibilityLabel={`「${schedule.label}」の収集日を削除`} onPress={() => void remove(schedule.id)} danger disabled={busy} />
          </View>
        </View></WasteSettingsItem>
      ))}</View> : null}

      {snapshot.wasteSchedules.length > 0 ? <SettingsGroup title="次の収集日">
      {nextSevenDays.length === 0 ? <Text style={styles.body}>次の収集日はありません。</Text> : nextSevenDays.map((occurrence) => (
        <WasteSettingsItem key={`${occurrence.scheduleId}-${occurrence.date}`}><View style={styles.occurrence}>
          <View style={styles.occurrenceCopy}>
            <Text style={styles.occurrenceDate}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text>
            <View style={styles.nameRow}><WasteTypeIcon label={occurrence.label} size={16} /><Text style={[styles.occurrenceLabel, { color: wasteTypeColor(occurrence.label) }]}>{occurrence.label}</Text></View>
          </View>
          <WasteSettingsAction title="今回は非表示" accessibilityLabel="今回は表示しない" quiet surface onPress={() => void setOccurrenceHidden(occurrence.scheduleId, occurrence.date, true)} disabled={busy} />
        </View></WasteSettingsItem>
      ))}
      </SettingsGroup> : null}

      {snapshot.hiddenWasteDates.length > 0 ? <><WasteSettingsHeading title="非表示の収集日" count={`${snapshot.hiddenWasteDates.length}件`} />
      <View>{snapshot.hiddenWasteDates.map((occurrence) => (
        <WasteSettingsItem key={`${occurrence.scheduleId}-${occurrence.date}`}><View style={styles.occurrence}>
          <View style={styles.occurrenceCopy}>
            <Text style={styles.occurrenceDate}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text>
            <Text style={[styles.occurrenceLabel, { color: wasteTypeColor(occurrence.label) }]}>{occurrence.label}</Text>
          </View>
          <WasteSettingsAction title="再表示" onPress={() => void setOccurrenceHidden(occurrence.scheduleId, occurrence.date, false)} disabled={busy} />
        </View></WasteSettingsItem>
      ))}</View></> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 14, gap: 14 }, nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  undo: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border, borderRadius: 12 },
  scheduleCard: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  scheduleCopy: { flex: 1, minWidth: 120, gap: 4 },
  scheduleName: { ...typography.label, flexShrink: 1, color: palette.ink, fontWeight: '600' },
  days: { ...typography.caption, color: palette.muted },
  actions: { flexDirection: 'row', gap: 6 },
  occurrence: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  occurrenceCopy: { flex: 1, minWidth: 160, gap: 4 },
  occurrenceDate: { ...typography.label, color: palette.ink, fontWeight: '500' },
  occurrenceLabel: { ...typography.caption, color: palette.ink, fontWeight: '500' },
  body: { ...typography.caption, color: palette.muted },
  error: { ...typography.label, color: palette.warning },
  success: { ...typography.label, color: palette.accent, fontWeight: '600' },
});
