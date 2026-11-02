import type { SQLiteDatabase } from 'expo-sqlite';
import { localDateFromDate } from '../../domain/scheduling/local-date';
import { createPersonalGoogleCalendarSync } from '../../features/calendar/personal-google-sync';
import { createGoogleCalendarApi } from './calendar-api';
import { authorizeGoogleCalendarEvents, getCurrentGoogleSubject, getGoogleCalendarEventsAccessToken } from '../google-tasks/google-sign-in-gateway';

const runtimes = new WeakMap<SQLiteDatabase, ReturnType<typeof createPersonalGoogleCalendarSync>>();
/** Same native Google identity and one per-database coordinator for every screen/foreground trigger. */
export function nativePersonalGoogleCalendar(database: SQLiteDatabase) {
  let value = runtimes.get(database);
  if (!value) {
    value = createPersonalGoogleCalendarSync({ database, currentSubject: getCurrentGoogleSubject,
      authorize: () => authorizeGoogleCalendarEvents(), today: () => localDateFromDate(new Date()),
      createApi: context => createGoogleCalendarApi({ ...context, token: () => getGoogleCalendarEventsAccessToken(context.subject) }) });
    runtimes.set(database, value);
  }
  return value;
}
