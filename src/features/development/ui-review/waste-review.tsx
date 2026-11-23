import { useState } from 'react';
import { PlannerLoadState } from '@/components/planner-load-state';
import { SettingsHeader } from '@/components/settings-header';
import type { LocalDate } from '@/domain/shared/types';
import type { WeeklyWasteSchedule } from '@/features/waste/contracts';
import { WasteSettingsContent } from '@/features/waste/waste-settings-content';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';

export const wasteReviewScenarios = [
  { id: 'waste-empty', label: 'ゴミ収集日・未登録' },
  { id: 'waste-offline', label: 'ゴミ収集日・オフラインの保存済み予定' },
  { id: 'waste-hidden', label: '今回だけ非表示の収集日・元に戻す' },
  { id: 'waste-read-error', label: '端末の収集日データを開けない' },
] as const;

const today: LocalDate = '2026-12-29';
const through: LocalDate = '2027-02-28';
const hiddenDate: LocalDate = '2026-12-30';
const householdId = 'ui-review-waste';
const schedules: WeeklyWasteSchedule[] = [
  { id: 'weekly', householdId, label: '燃やすごみ', collectionWeekdays: [3, 6] },
  { id: 'biweekly', householdId, label: 'びん・缶', collectionWeekdays: [3], recurrence: 'biweekly', anchorDate: hiddenDate },
  { id: 'monthly', householdId, label: '古紙', collectionWeekdays: [], recurrence: 'monthly', monthlyDay: 31 },
];
const noRefresh = async () => {};

export function WasteReview({ scenario, onExit }: { scenario: string; onExit(): void }) {
  const [rows, setRows] = useState(scenario === 'waste-empty' ? [] : schedules);
  const [hidden, setHidden] = useState(() => new Set(scenario === 'waste-hidden' ? [`biweekly:${hiddenDate}`] : []));
  const [failed, setFailed] = useState(scenario === 'waste-read-error');
  const [newId, setNewId] = useState(1);
  const header = <SettingsHeader title="ゴミ収集日" onBack={onExit} backAccessibilityLabel="UI確認用データ一覧へ戻る" />;
  if (failed) return <PlannerLoadState header={header} message="収集日を読み込んでいます。" error="端末の収集日データを開けませんでした。" retry={async () => setFailed(false)} />;
  const occurrences = rows.flatMap(schedule => generateWasteCollectionDates(schedule, today, through));
  return <WasteSettingsContent snapshot={{ today, wasteSchedules: rows,
    upcomingWasteDates: occurrences.filter(row => !hidden.has(`${row.scheduleId}:${row.date}`)),
    hiddenWasteDates: occurrences.filter(row => hidden.has(`${row.scheduleId}:${row.date}`)) }}
    header={header} refresh={noRefresh} saveSchedule={async (input, editing) => {
      const replacement: WeeklyWasteSchedule = { ...input, householdId, id: editing?.id ?? `new-${newId}` };
      if (editing) setRows(before => before.map(row => row.id === editing.id ? replacement : row));
      else { setRows(before => [...before, replacement]); setNewId(value => value + 1); }
    }} deleteSchedule={async id => {
      const index = rows.findIndex(row => row.id === id);
      const previous = rows[index];
      if (!previous) return null;
      setRows(before => before.filter(row => row.id !== id));
      return { label: previous.label, action: async () => setRows(before => [...before.slice(0, index), previous, ...before.slice(index)]) };
    }} setHidden={async (id, date, hide) => setHidden(before => {
      const next = new Set(before);
      if (hide) next.add(`${id}:${date}`); else next.delete(`${id}:${date}`);
      return next;
    })} />;
}
