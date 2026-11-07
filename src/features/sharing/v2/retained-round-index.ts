import type { LocalDate } from '../../../domain/shared/types';
import type { V2RetainedRoundState } from './history-retention-schema';
/** Includes undone rounds: their empty reports intentionally fence older retained anchors. */
export function indexRetainedRounds(rows: readonly V2RetainedRoundState[]) {
  const chores = new Map<string, V2RetainedRoundState[]>(); const rounds = new Map<string, V2RetainedRoundState[]>();
  const key = (id: string, date: LocalDate, version: number) => JSON.stringify([id, date, version]);
  for (const row of rows) {
    const id = row.choreId; const round = key(id, row.anchorDate, row.ruleVersion);
    const byChore = chores.get(id) ?? []; byChore.push(row); chores.set(id, byChore);
    const byRound = rounds.get(round) ?? []; byRound.push(row); rounds.set(round, byRound);
  }
  return { forChore: (id: string) => chores.get(id) ?? [],
    forRound: (id: string, date: LocalDate, version: number) => rounds.get(key(id, date, version)) ?? [] };
}
