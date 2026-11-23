import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { PlannerLoadState } from '@/components/planner-load-state';
import { SettingsHeader } from '@/components/settings-header';
import { newEventDraft } from '@/domain/calendar/events';
import { PlannerCalendar } from '@/features/calendar/planner-calendar';
import { EMPTY_LOCAL_CALENDAR, readLocalCalendar, saveCalendarDraft, saveCalendarEvent } from '@/platform/storage/calendar-events';
import { migrateLocalDatabase } from '@/platform/storage/migrations';
import { createCalendarReviewPreferences } from './calendar-preferences';

const today = '2026-11-23';
const timeZone = 'Asia/Tokyo';
let nameSequence = 0;

async function seedCalendar(database: SQLiteDatabase, seedDraft: boolean) {
  await migrateLocalDatabase(database);
  await database.runAsync('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)', 'local-household', 'UI確認用のカレンダー', `${today}T00:00:00Z`);
  const value = { ...newEventDraft(today, timeZone), title: '図書館で読書会', location: '中央図書館', startMinute: 540, endMinute: 600 };
  await saveCalendarEvent(database, { expectedRevision: 0, value: { ...value, recurrence: 'weekly' } });
  await saveCalendarEvent(database, { expectedRevision: 0, value: { ...value, title: '返却する本をまとめる', location: '', startMinute: 555, endMinute: 570 } });
  if (seedDraft) await saveCalendarDraft(database, { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series',
    value: { ...value, title: '来週の打ち合わせ', notes: '参加者に確認してから保存する。' } });
  return readLocalCalendar(database);
}

export function CalendarEditReview({ seedDraft, onExit }: { seedDraft: boolean; onExit?(): void }) {
  const [preferences] = useState(() => createCalendarReviewPreferences('day'));
  useEffect(() => () => preferences.display.dispose(), [preferences]);
  const [database, setDatabase] = useState<SQLiteDatabase>();
  const [snapshot, setSnapshot] = useState(EMPTY_LOCAL_CALENDAR);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Use a separate file. Native exclusive transactions use their own connection.
    const name = `liflow-ui-review-calendar-${Date.now()}-${++nameSequence}.db`;
    let disposed = false;
    const pending = (async () => {
      const db = await openDatabaseAsync(name, { useNewConnection: true });
      try {
        const initial = await seedCalendar(db, seedDraft);
        if (!disposed) { setSnapshot(initial); setDatabase(db); }
      } catch (cause) {
        if (!disposed) setLoadError('確認用の予定を開けませんでした。');
        await db.closeAsync();
        throw cause;
      }
      return db;
    })();
    void pending.catch(() => { if (!disposed) setLoadError('確認用の予定を開けませんでした。'); });
    return () => {
      disposed = true;
      void pending.then(db => db.closeAsync()).catch(() => {}).then(() => deleteDatabaseAsync(name)).catch(() => {});
    };
  }, [seedDraft, attempt]);
  const refresh = useCallback(async () => {
    if (database) setSnapshot(await readLocalCalendar(database));
  }, [database]);
  if (!database) return <PlannerLoadState header={<SettingsHeader title="カレンダー" onBack={onExit} backAccessibilityLabel="UI確認用データ一覧へ戻る" />}
    message="予定を読み込んでいます。" error={loadError} retry={async () => { setLoadError(null); setAttempt(value => value + 1); }} />;
  return <PlannerCalendar today={today} timeZone={timeZone} local={{ database, snapshot, loading: false, error: null, refresh }}
    dayInfo={() => ({ loaded: true, total: 0, pending: 0, minutes: 0 })} renderChores={() => null}
    preview={{ preferences, currentMinute: 540, onExit }} />;
}
