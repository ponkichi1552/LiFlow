import { useLocalCalendar } from '../../src/features/calendar/use-local-calendar';
import type { LocalCalendarBinding } from '../../src/features/calendar/use-local-calendar';
import type { SQLiteDatabase } from 'expo-sqlite';
export function LocalCalendarObserverHost({ database, capture }: { database: SQLiteDatabase; capture(value: LocalCalendarBinding): void }) {
  capture(useLocalCalendar(database, true)); return null;
}
