import { useCallback, useEffect, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_CALENDAR_REMINDERS, readCalendarReminders, subscribeCalendarReminders, type CalendarReminderSettings } from '../../platform/storage/calendar-reminders';

export function useCalendarReminders(database?: SQLiteDatabase) {
  const [value, setValue] = useState<{ database: SQLiteDatabase; settings: CalendarReminderSettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => { if (!database) return; const settings = await readCalendarReminders(database); setValue({ database, settings }); setError(null); }, [database]);
  useEffect(() => { let live = true;
    const read = () => { if (!database) return; void readCalendarReminders(database).then(settings => { if (live) { setValue({ database, settings }); setError(null); } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : '通知設定を読み込めませんでした。'); }); };
    read(); const stop = database ? subscribeCalendarReminders(database, read) : undefined;
    return () => { live = false; stop?.(); };
  }, [database]);
  return { settings: value && value.database === database ? value.settings : EMPTY_CALENDAR_REMINDERS, loading: Boolean(database && value?.database !== database), error, refresh };
}
