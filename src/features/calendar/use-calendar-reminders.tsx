import { useCallback, useEffect, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_CALENDAR_REMINDERS, readCalendarReminders, subscribeCalendarReminders, type CalendarReminderSettings } from '../../platform/storage/calendar-reminders';

export function useCalendarReminders(database?: SQLiteDatabase) {
  const [value, setValue] = useState<{ database: SQLiteDatabase; settings: CalendarReminderSettings } | null>(null);
  const [failure, setFailure] = useState<{ database: SQLiteDatabase; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setFailure(null); setAttempt(previous => previous + 1); }, []);
  useEffect(() => {
    if (!database) return;
    let live = true;
    let revision = 0;
    const read = () => {
      const requested = ++revision;
      void readCalendarReminders(database).then(settings => {
        if (live && requested === revision) { setValue({ database, settings }); setFailure(null); }
      }).catch(cause => {
        if (live && requested === revision) setFailure({ database, message: cause instanceof Error ? cause.message : '通知設定を読み込めませんでした。' });
      });
    };
    const stop = subscribeCalendarReminders(database, read);
    read();
    return () => { live = false; stop(); };
  }, [database, attempt]);
  const error = failure?.database === database ? failure?.message ?? null : null;
  return { settings: value?.database === database ? value?.settings ?? EMPTY_CALENDAR_REMINDERS : EMPTY_CALENDAR_REMINDERS,
    loading: Boolean(database && value?.database !== database && !error), error, retry };
}
