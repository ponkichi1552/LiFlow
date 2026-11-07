import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreState } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import { completionCycleDate } from '../../domain/scheduling/completion-matching.ts';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';
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
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    await database.runAsync(`INSERT INTO chore_completion_actions
    (operation_id,completion_id,chore_id,action,completed_at,completed_local_date,time_zone,scheduled_date,
     scheduled_window_start,previous_chore_state_json,source,origin) VALUES ${batch.map(() => "(?,?,?,'legacy',?,?,?,?,?,?,?,?)").join(',')}`,
    ...batch.flatMap(row => [`legacy.${row.id}`, row.id, choreId, row.completed_at,
      row.completed_local_date ?? sharedLocalDate(new Date(row.completed_at), row.completed_time_zone ?? timeZone), row.completed_time_zone ?? timeZone,
      row.scheduled_date, row.scheduled_window_start, row.previous_chore_state_json, row.source ?? 'inApp',
      parseSharedMirrorEntryId(row.schedule_entry_id) ? 'shared' : 'personal']));
  }
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
  now, sharedLocalDate(new Date(now), timeZone), timeZone, source, target.origin);
}

/** Walk the exact prior-state lineage for an undo without changing the completion projection. */
export function previousCompletionState(targetAction: CompletionActionRow, actionHistory: readonly CompletionActionRow[],
  heads: ReadonlyMap<string, CompletionActionRow>, datedHistory: readonly (CompletionActionRow & { cycleDate: LocalDate })[]): ChoreState | null {
    const bySequence = new Map(actionHistory.map(row => [row.sequence, row]));
    let previousState = JSON.parse(targetAction.previous_chore_state_json!) as ChoreState | null;
    let prior = targetAction;
    while (prior.action !== 'legacy' && prior.previous_action_sequence !== null) {
      const parent = bySequence.get(prior.previous_action_sequence);
      if (!parent || parent.sequence >= prior.sequence) throw new Error('完了操作の順序を確認できません。');
      const current = heads.get(parent.completion_id);
      if (current?.outcome === 'completed' && current.sequence === parent.sequence) break;
      previousState = parent.previous_chore_state_json === null ? null : JSON.parse(parent.previous_chore_state_json);
      prior = parent;
    }
    let beforeSequence = prior.sequence;
    const undoneByDate = new Map<LocalDate, (CompletionActionRow & { cycleDate: LocalDate })[]>();
    if (prior.action === 'legacy') for (const row of datedHistory) if (row.outcome === 'incomplete' && row.previous_chore_state_json !== null) {
      const rows = undoneByDate.get(row.cycleDate) ?? []; rows.push(row); undoneByDate.set(row.cycleDate, rows);
    }
    for (const rows of undoneByDate.values()) rows.sort((a, b) => b.sequence - a.sequence);
    // A saved prior state may itself point at a completion that was undone earlier.
    while (prior.action === 'legacy' && previousState?.lastCompletedDate) {
      const previousDate = previousState.lastCompletedDate;
      const rows = undoneByDate.get(previousDate) ?? [];
      let low = 0; let high = rows.length;
      while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].sequence >= beforeSequence) low = middle + 1; else high = middle; }
      const undonePrevious = rows[low];
      if (!undonePrevious) break;
      previousState = JSON.parse(undonePrevious.previous_chore_state_json!) as ChoreState | null;
      beforeSequence = undonePrevious.sequence;
    }
    return previousState;
}
