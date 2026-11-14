import type { SQLiteDatabase } from 'expo-sqlite';
import { calendarDraftKey, clearSubmittedCalendarDraft, type CalendarEditorDraft } from '../../platform/storage/calendar-events';

/** Only snapshots written by this editor may be cleaned up after changing destination. */
export function createEditorDraftSession(initial?: CalendarEditorDraft) {
  const owned = new Map<string, CalendarEditorDraft>();
  const remember = (draft: CalendarEditorDraft) => owned.set(calendarDraftKey(draft), JSON.parse(JSON.stringify(draft)) as CalendarEditorDraft);
  if (initial) remember(initial);
  return {
    remember,
    snapshot: (draft: CalendarEditorDraft) => owned.get(calendarDraftKey(draft)),
    async clear(database: SQLiteDatabase, keep?: CalendarEditorDraft) {
      const keepKey = keep && calendarDraftKey(keep);
      for (const [key, snapshot] of [...owned]) {
        if (key === keepKey) continue;
        // Compare-and-delete preserves any input subsequently saved by another editor.
        await clearSubmittedCalendarDraft(database, snapshot);
        if (owned.get(key) === snapshot) owned.delete(key);
      }
    },
  };
}
