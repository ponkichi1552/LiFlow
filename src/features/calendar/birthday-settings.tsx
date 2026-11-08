import { useLayoutEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { SettingsAction } from '../../components/settings-controls';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types';
import { useLocalCalendar } from './use-local-calendar';
import { CalendarField } from './calendar-field';
import { localDateFromDate } from '../../domain/scheduling/local-date';
import { OWN_BIRTHDAY_EVENT_ID, saveOwnBirthday } from '../../platform/storage/calendar-events';

export function BirthdaySettings({ database, today = localDateFromDate(new Date()), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, embedded = false }: {
  database: SQLiteDatabase; today?: LocalDate; timeZone?: string; embedded?: boolean;
}) {
  const local = useLocalCalendar(database);
  const own = local.snapshot.events.find(event => event.id === OWN_BIRTHDAY_EVENT_ID);
  const [attempt, setAttempt] = useState<{ database: SQLiteDatabase; date: LocalDate; error?: string } | null>(null);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const current = useRef<SQLiteDatabase | null>(database);
  useLayoutEffect(() => { current.current = database; return () => { current.current = null; }; }, [database]);
  const pending = attempt?.database === database ? attempt : null;
  const date = pending?.date ?? own?.startDate ?? today;
  const save = async (date: LocalDate) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setAttempt({ database, date });
    try {
      await saveOwnBirthday(database, { date, timeZone: own?.timeZone ?? timeZone, expectedRevision: own?.revision ?? 0 });
      await local.refresh();
      if (current.current === database) setAttempt(null);
    } catch (cause) {
      if (current.current === database) setAttempt({ database, date, error: cause instanceof Error ? cause.message : '誕生日を保存できませんでした。' });
      // Refresh the revision after a conflicting edit; keep the selected date for retry.
      await local.refresh();
    } finally { lock.current = false; if (current.current) setBusy(false); }
  };
  return <View style={{ gap: 8 }}>
    <Text style={{ ...typography.caption, color: palette.muted }}>カレンダーに誕生日を表示します。</Text>
    <CalendarField label="自分の誕生日" hideLabel date={date} minute={0} mode="date" commitOnDone
      displayValue={pending || own ? `${Number(date.slice(5, 7))}月${Number(date.slice(-2))}日` : '未登録'}
      disabled={busy || local.loading} onDate={date => void save(date)} />
    {local.error || pending?.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{pending?.error ?? local.error}</Text> : null}
    {pending?.error ? <SettingsAction title="再試行" placement={embedded ? 'panel' : 'page'} disabled={busy} onPress={() => void save(pending.date)} /> : null}
  </View>;
}
