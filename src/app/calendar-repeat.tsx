import { useLayoutEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { Text } from 'react-native';
import { BackButton, Page, palette, typography } from '@/components/planner-ui';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useLocalCalendar } from '@/features/calendar/use-local-calendar';
import { CustomRecurrenceScreen } from '@/features/calendar/custom-recurrence-screen';
import { calendarDraftKey, calendarDraftVersion, saveCalendarDraft } from '@/platform/storage/calendar-events';
import type { CalendarEditorDraft } from '@/platform/storage/calendar-events';

export default function CalendarRepeatRoute() {
  const params = useLocalSearchParams<{ draft?: string; returnTo?: string }>();
  const { database } = usePlannerData({ personal: true }); const local = useLocalCalendar(database, true);
  const key = typeof params.draft === 'string' && params.draft.length <= 240 ? params.draft : undefined;
  const draft = (local.snapshot.drafts ?? (local.snapshot.draft ? [local.snapshot.draft] : [])).find(row => calendarDraftKey(row) === key);
  const [leaving, setLeaving] = useState(false); const leaveLock = useRef(false); const saving = useRef(false);
  const disableNavigationGuard = useRef<() => void>(() => {});
  const leave = async (returned = draft) => {
    if (leaveLock.current || saving.current) return; leaveLock.current = true;
    await local.refresh(); setLeaving(true); disableNavigationGuard.current();
    router.navigate({ pathname: '/(tabs)/explore', params: returned ? { calendarDraft: calendarDraftKey(returned), calendarDraftVersion: calendarDraftVersion(returned) } : {} });
  };
  const back = () => { void leave(); };
  const disablePrevention = usePreventRemove(!leaving, back);
  useLayoutEffect(() => { disableNavigationGuard.current = disablePrevention; }, [disablePrevention]);
  if (!draft) return <Page><BackButton accessibilityLabel="予定の入力に戻る" onPress={back} /><Text style={{ ...typography.body, color: palette.muted }}>{local.error ?? (local.loading ? '入力内容を読み込んでいます。' : '入力途中の予定が見つかりません。カレンダーへ戻ってください。')}</Text></Page>;
  if (draft.value.birthday || draft.scope === 'one') return <Page><BackButton accessibilityLabel="予定の入力に戻る" onPress={back} /><Text style={{ ...typography.body, color: palette.muted }}>{draft.value.birthday ? '誕生日は毎年の繰り返しです。' : '繰り返し全体を選んでから設定してください。'}</Text></Page>;
  return <CustomRecurrenceScreen key={key} date={draft.value.startDate} initial={draft.value.customRecurrence} onBack={back} onSave={async rule => {
    if (!database) throw new Error('入力内容の保存先を確認してください。'); if (saving.current) return; saving.current = true;
    const next: CalendarEditorDraft = { ...draft, value: { ...draft.value, recurrence: 'custom', customRecurrence: rule } };
    try { await saveCalendarDraft(database, next); }
    finally { saving.current = false; }
    await leave(next);
  }} />;
}
