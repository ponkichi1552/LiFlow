import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreState } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import { completionCycleDate } from '../../domain/scheduling/completion-matching.ts';
import { localDateFromISODateTime } from '../../domain/scheduling/local-date.ts';
import { parseSharedMirrorEntryId } from '../../features/planner/common-chore-links.ts';

export interface CompletionActionRow {
  sequence: number; completion_id: string; action: 'complete' | 'undo' | 'legacy'; target_sequence: number | null;
  previous_action_sequence: number | null; completed_at: string; completed_local_date: LocalDate; time_zone: string;
  scheduled_date: LocalDate | null; scheduled_window_start: LocalDate | null; previous_chore_state_json: string | null;
  outcome: 'completed' | 'incomplete'; origin: 'personal' | 'shared';
}
export const actionCycleDate = (row: CompletionActionRow) => completionCycleDate({ completedAt: row.completed_at,
  completedLocalDate: row.completed_local_date, scheduledDate: row.scheduled_date ?? undefined, scheduledWindowStart: row.scheduled_window_start ?? undefined });

/** These functions run inside the same transaction as the completion projection and Google Outbox. */
export async function seedCompletionJournalInside(database: SQLiteDatabase, choreId: string, timeZone: string) {
  const rows = await database.getAllAsync<{ id: string; completed_at: string; scheduled_date: LocalDate | null;
    completed_local_date: LocalDate | null; completed_time_zone: string | null;
    scheduled_window_start: LocalDate | null; previous_chore_state_json: string | null; source: string; schedule_entry_id: string | null }>(
    `SELECT c.* FROM chore_completions c WHERE c.chore_id=? AND NOT EXISTS
      (SELECT 1 FROM chore_completion_actions a WHERE a.completion_id=c.id AND a.action IN ('complete','legacy')) ORDER BY c.rowid`, choreId);
  for (const row of rows) await database.runAsync(`INSERT INTO chore_completion_actions
    (operation_id,completion_id,chore_id,action,completed_at,completed_local_date,time_zone,scheduled_date,
     scheduled_window_start,previous_chore_state_json,source,origin) VALUES(?,?,?,'legacy',?,?,?,?,?,?,?,?)`,
  `legacy.${row.id}`, row.id, choreId, row.completed_at, row.completed_local_date ?? localDateFromISODateTime(row.completed_at), row.completed_time_zone ?? timeZone,
  row.scheduled_date, row.scheduled_window_start, row.previous_chore_state_json, row.source ?? 'inApp',
  parseSharedMirrorEntryId(row.schedule_entry_id) ? 'shared' : 'personal');
}

export function readCompletionJournalInside(database: SQLiteDatabase, choreId: string) {
  return database.getAllAsync<CompletionActionRow>(`SELECT a.*,c.outcome FROM chore_completion_actions a
    JOIN chore_completions c ON c.id=a.completion_id WHERE a.chore_id=? AND a.action IN ('complete','legacy') ORDER BY a.sequence DESC`, choreId);
}

export async function appendCompletionActionInside(database: SQLiteDatabase, input: {
  operationId: string; completionId: string; choreId: string; completedAt: string; localDate: LocalDate; timeZone: string;
  scheduledDate?: LocalDate; windowStart?: LocalDate; previousState: ChoreState | null; source: string; origin: 'personal' | 'shared';
}) {
  // An actual anchor comes from an actual local completion day, not the date
  // a future checkmark was scheduled for. Query only its active latest version.
  const parent = input.previousState?.lastCompletedDate && !input.previousState.lastCompletedEstimated
    ? await database.getFirstAsync<{ sequence: number }>(`SELECT a.sequence FROM chore_completion_actions a
      JOIN chore_completions c ON c.id=a.completion_id WHERE a.chore_id=? AND a.completion_id<>?
      AND a.completed_local_date=? AND c.outcome='completed' AND a.action IN ('complete','legacy')
      AND NOT EXISTS (SELECT 1 FROM chore_completion_actions newer WHERE newer.completion_id=a.completion_id
        AND newer.action IN ('complete','legacy') AND newer.sequence>a.sequence) ORDER BY a.sequence DESC LIMIT 1`,
    input.choreId, input.completionId, input.previousState.lastCompletedDate) : null;
  await database.runAsync(`INSERT INTO chore_completion_actions
    (operation_id,completion_id,chore_id,action,previous_action_sequence,completed_at,completed_local_date,time_zone,
     scheduled_date,scheduled_window_start,previous_chore_state_json,source,origin) VALUES(?,?,?,'complete',?,?,?,?,?,?,?,?,?)`,
  input.operationId, input.completionId, input.choreId, parent?.sequence ?? null, input.completedAt, input.localDate, input.timeZone,
  input.scheduledDate ?? null, input.windowStart ?? null, JSON.stringify(input.previousState), input.source, input.origin);
}

export async function appendCompletionUndoInside(database: SQLiteDatabase, operationId: string, target: CompletionActionRow,
  choreId: string, timeZone: string, now: string, source: string) {
  await database.runAsync(`INSERT INTO chore_completion_actions
    (operation_id,completion_id,chore_id,action,target_sequence,completed_at,completed_local_date,time_zone,source,origin)
    VALUES(?,?,?,'undo',?,?,?,?,?,?)`, operationId, target.completion_id, choreId, target.sequence,
  now, localDateFromISODateTime(now), timeZone, source, target.origin);
}
