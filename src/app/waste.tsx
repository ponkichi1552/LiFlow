import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import { AccordionSection } from '@/components/accordion-section';
import { WasteScheduleEditor } from '@/features/waste/waste-schedule-editor';
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
  const [expandedUpcoming, setExpandedUpcoming] = useState(false);
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
    <Page header={<BackButton onPress={() => router.back()} />} floatingFooter footer={undo ?
      <View style={styles.undo}><Text numberOfLines={1} style={[styles.body, { flex: 1 }]}>{undo.label}</Text>
        <AppButton title="元に戻す" accessibilityLabel={`${undo.label}を元に戻す`} compact variant="quiet" disabled={busy} onPress={() => void revert()} />
      </View> : undefined}>

      <ScreenHeading eyebrow="WASTE DAY" title="ゴミ収集日" description="ゴミの種類を検索して選び、曜日や周期を登録します。" />
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}

      <WasteScheduleEditor key={editing?.id ?? 'new'} initial={editing} referenceDate={snapshot.today} onSubmit={save} onCancel={editing ? () => setEditing(undefined) : undefined} disabled={busy} />
      {message ? <Text accessibilityLiveRegion="polite" style={message.includes('しました') ? styles.success : styles.error}>{message}</Text> : null}

      <SectionHeading title="登録済み" trailing={<Text style={styles.count}>{snapshot.wasteSchedules.length}種類</Text>} />
      {snapshot.wasteSchedules.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>ゴミの曜日はまだありません</Text><Text style={styles.body}>収集区分と曜日を追加すると、次の収集日を表示します。</Text></Card>
      ) : snapshot.wasteSchedules.map((schedule) => (
        <Card key={schedule.id} style={[styles.scheduleCard, { borderLeftColor: wasteTypeColor(schedule.label), borderLeftWidth: 4 }]}>
          <View style={styles.scheduleCopy}>
            <Text style={[styles.scheduleName, { color: wasteTypeColor(schedule.label) }]}>{schedule.label}</Text>
            <Text style={styles.days}>{wasteScheduleDescription(schedule)}</Text>
          </View>
          <View style={styles.actions}>
            <AppButton title="編集" onPress={() => { setEditing(schedule); setMessage(null); }} variant="secondary" disabled={busy} compact />
            <AppButton title="削除" onPress={() => void remove(schedule.id)} variant="danger" disabled={busy} compact />
          </View>
        </Card>
      ))}

      <AccordionSection title="次の収集日" expanded={expandedUpcoming} onToggle={() => setExpandedUpcoming((value) => !value)}>
      {nextSevenDays.length === 0 ? <Card><Text style={styles.body}>表示できる収集日はありません。曜日を登録してください。</Text></Card> : nextSevenDays.map((occurrence) => (
        <Card key={`${occurrence.scheduleId}-${occurrence.date}`} style={[styles.occurrence, { borderLeftColor: wasteTypeColor(occurrence.label), borderLeftWidth: 4 }]}>
          <View style={styles.occurrenceCopy}>
            <Text style={styles.occurrenceDate}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text>
            <Text style={[styles.occurrenceLabel, { color: wasteTypeColor(occurrence.label) }]}>{occurrence.label}</Text>
          </View>
          <AppButton title="今回は表示しない" onPress={() => void setOccurrenceHidden(occurrence.scheduleId, occurrence.date, true)} variant="quiet" disabled={busy} compact />
        </Card>
      ))}
      </AccordionSection>

      <SectionHeading title="非表示にしたゴミ予定" trailing={<Text style={styles.count}>{snapshot.hiddenWasteDates.length}件</Text>} />
      {snapshot.hiddenWasteDates.length === 0 ? (
        <Card><Text style={styles.body}>非表示にした予定はありません。</Text></Card>
      ) : snapshot.hiddenWasteDates.map((occurrence) => (
        <Card key={`${occurrence.scheduleId}-${occurrence.date}`} style={styles.occurrence}>
          <View style={styles.occurrenceCopy}>
            <Text style={styles.occurrenceDate}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text>
            <Text style={[styles.occurrenceLabel, { color: wasteTypeColor(occurrence.label) }]}>{occurrence.label}</Text>
          </View>
          <AppButton title="再表示" onPress={() => void setOccurrenceHidden(occurrence.scheduleId, occurrence.date, false)} variant="secondary" disabled={busy} compact />
        </Card>
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  undo: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border, borderRadius: 12 },
  count: { ...typography.caption, color: palette.muted },
  scheduleCard: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  scheduleCopy: { flex: 1, minWidth: 120, gap: 4 },
  scheduleName: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  days: { ...typography.caption, color: palette.muted },
  actions: { flexDirection: 'row', gap: 6 },
  occurrence: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  occurrenceCopy: { flex: 1, minWidth: 160, gap: 4 },
  occurrenceDate: { ...typography.label, color: palette.accent, fontWeight: '700' },
  occurrenceLabel: { ...typography.body, color: palette.ink, fontWeight: '600' },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  body: { ...typography.body, color: palette.muted },
  error: { ...typography.label, color: palette.warning },
  success: { ...typography.label, color: palette.accent, fontWeight: '600' },
});
