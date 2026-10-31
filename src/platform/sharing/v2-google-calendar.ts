import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createSharedCalendarExportStore } from '../storage/sharing-v2-calendar-export';
import { createSharedGoogleCalendarExport } from '../../features/calendar/shared-google-export';
import { createGoogleCalendarApi } from '../google-calendar/calendar-api';
import { authorizeGoogleCalendarEvents, getCurrentGoogleSubject, getGoogleCalendarEventsAccessToken } from '../google-tasks/google-sign-in-gateway';

export function createNativeV2GoogleCalendar(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string; assertAccess(): Promise<void> }) {
  return createSharedGoogleCalendarExport({ store: createSharedCalendarExportStore(input.repository), scope: { userId: input.userId, groupId: input.groupId }, assertAccess: input.assertAccess,
    authorize: authorizeGoogleCalendarEvents, currentSubject: getCurrentGoogleSubject,
    createApi: context => createGoogleCalendarApi({ ...context, token: () => getGoogleCalendarEventsAccessToken(context.subject) }) });
}
