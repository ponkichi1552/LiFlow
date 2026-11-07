import type { SQLiteDatabase } from 'expo-sqlite';
import type { ChoreDefinition, ChoreScheduleEntry } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import type { ClothingRegion, ClothingSeasonalWork, PersonalSeasonalRound } from '../../domain/scheduling/adaptive/seasonal';
import { CLOTHING_SEASONAL_TABLE_VERSION, completePersonalSeasonalRound, initializePersonalSeasonalRounds,
  updatePersonalSeasonalRegion } from '../../domain/scheduling/adaptive/seasonal.ts';
import { daysBetween } from '../../domain/scheduling/local-date.ts';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock.ts';

const works: readonly ClothingSeasonalWork[] = ['winterStorage', 'summerStorage'];
interface SeasonalState {
  choreId: string; enabled: boolean; region: ClothingRegion;
  initial: Record<ClothingSeasonalWork, PersonalSeasonalRound>;
  pending: Record<ClothingSeasonalWork, PersonalSeasonalRound>;
}
export interface PersonalSeasonalView { revision: number; sourceRevision: string; state: SeasonalState }
interface SeasonalContext {
  chore: ChoreDefinition; region: ClothingRegion; today: LocalDate; now: string;
  assertInputsCurrent(): void | Promise<void>; fingerprint(value: unknown): string;
}
export type PersonalSeasonalOperation = { operationId: string; recordedAt: string } & (
  | { type: 'complete'; completionId: string; roundId: string; date: LocalDate; timeZone: string; origin: 'personal' | 'shared' }
  | { type: 'undo'; completionId: string; targetOperationId: string }
);
export interface PersonalSeasonalReceipt { operationId: string; kind: 'applied' | 'alreadyCompleted' | 'alreadyUndone' | 'staleRound'; revision: number }
interface SeasonalCompletion {
  seasonal: true; operationId: string; recordedAt: string; type: 'complete'; completionId: string; roundId: string;
  work: ClothingSeasonalWork; frozenPlan: PersonalSeasonalRound; date: LocalDate; timeZone: string; origin: 'personal' | 'shared';
}
type SeasonalEvent = SeasonalCompletion | { seasonal: true; operationId: string; recordedAt: string; type: 'undo'; completionId: string; targetOperationId: string };
async function requireTransaction(database: SQLiteDatabase) {
  if (!await database.isInTransactionAsync()) throw new Error('季節家事は完了と同じトランザクションで保存してください。');
}
export async function readPersonalSeasonalInside(database: SQLiteDatabase, choreId: string): Promise<PersonalSeasonalView | null> {
  const row = await database.getFirstAsync<{ revision: number; state_json: string; source_revision: string }>('SELECT * FROM personal_seasonal_state WHERE chore_id=?', choreId);
  if (!row) return null; const state = JSON.parse(row.state_json) as SeasonalState;
  if (state.choreId !== choreId || !Number.isSafeInteger(row.revision) || row.revision < 1
    || works.some(work => state.pending?.[work]?.choreId !== choreId || state.pending[work].work !== work || state.initial?.[work]?.work !== work)) throw new Error('季節家事の保存状態を確認してください。');
  return { revision: row.revision, sourceRevision: row.source_revision, state };
}
async function writeState(database: SQLiteDatabase, context: SeasonalContext, state: SeasonalState, previous: PersonalSeasonalView | null) {
  const sourceRevision = context.fingerprint([context.chore.enabled, context.region, CLOTHING_SEASONAL_TABLE_VERSION]);
  if (previous?.sourceRevision === sourceRevision && JSON.stringify(previous.state) === JSON.stringify(state)) return previous;
  const revision = (previous?.revision ?? 0) + 1;
  await context.assertInputsCurrent();
  for (const plan of Object.values(state.pending)) if (JSON.stringify(previous?.state.pending[plan.work]) !== JSON.stringify(plan)) await database.runAsync(`INSERT INTO personal_adaptive_plans
    (round_id,revision,chore_id,plan_json,input_revision,published_at) VALUES(?,?,?,?,?,?) ON CONFLICT(round_id,revision) DO NOTHING`,
  plan.id, context.fingerprint(['seasonal-plan-v1', plan]), context.chore.id, JSON.stringify(plan), sourceRevision, context.now);
  const changed = previous ? await database.runAsync(`UPDATE personal_seasonal_state SET revision=?,state_json=?,source_revision=?
    WHERE chore_id=? AND revision=?`, revision, JSON.stringify(state), sourceRevision, context.chore.id, previous.revision)
    : await database.runAsync('INSERT INTO personal_seasonal_state VALUES(?,?,?,?)', context.chore.id, revision, JSON.stringify(state), sourceRevision);
  if (changed.changes !== 1) throw new Error('別の操作で季節家事が更新されました。');
  await context.assertInputsCurrent();
  return { revision, sourceRevision, state };
}

/** Reuses the personal operation ledger and immutable plan versions; no duplicate learning history. */
export async function synchronizePersonalSeasonalInside(database: SQLiteDatabase, context: SeasonalContext): Promise<PersonalSeasonalView | null> {
  await requireTransaction(database); const previous = await readPersonalSeasonalInside(database, context.chore.id);
  if (!previous && !context.chore.enabled) return null;
  const revision = context.fingerprint([context.chore.enabled, context.region, CLOTHING_SEASONAL_TABLE_VERSION]);
  if (previous?.sourceRevision === revision) return previous;
  const initial = previous?.state.initial ?? Object.fromEntries(initializePersonalSeasonalRounds({ choreId: context.chore.id,
    region: context.region, today: context.today, fingerprint: context.fingerprint }).map(round => [round.work, round])) as SeasonalState['initial'];
  const pending = previous ? Object.fromEntries(works.map(work => [work, updatePersonalSeasonalRegion(previous.state.pending[work], {
    region: context.region, today: context.today, completedRoundIds: new Set(), fingerprint: context.fingerprint })])) as SeasonalState['pending'] : { ...initial };
  return writeState(database, context, { choreId: context.chore.id, enabled: context.chore.enabled, region: context.region, initial, pending }, previous);
}
async function seasonalHistory(database: SQLiteDatabase, choreId: string) {
  const rows = await database.getAllAsync<{ operation_id: string; event_json: string }>(
    'SELECT operation_id,event_json FROM personal_adaptive_actions WHERE chore_id=? AND event_json IS NOT NULL ORDER BY sequence', choreId);
  const events = rows.map(row => JSON.parse(row.event_json) as SeasonalEvent);
  if (events.some(event => event.seasonal !== true || !['complete', 'undo'].includes(event.type))) throw new Error('季節家事の操作履歴を確認してください。');
  const active = new Map<string, SeasonalCompletion>();
  for (const event of events) {
    if (event.type === 'complete') active.set(event.operationId, event);
    else active.delete(event.targetOperationId);
  }
  return { events, active };
}
export async function applyPersonalSeasonalInside(database: SQLiteDatabase, context: SeasonalContext,
  operation: PersonalSeasonalOperation): Promise<PersonalSeasonalReceipt> {
  await requireTransaction(database);
  if (!operation.operationId || operation.operationId.length > 512 || !Number.isFinite(Date.parse(operation.recordedAt))) throw new Error('季節家事の操作を確認してください。');
  const requestDigest = context.fingerprint(['seasonal-operation-v1', context.chore.id, operation]);
  const recorded = await database.getFirstAsync<{ chore_id: string; request_digest: string; receipt_json: string }>(
    'SELECT chore_id,request_digest,receipt_json FROM personal_adaptive_actions WHERE operation_id=?', operation.operationId);
  if (recorded) {
    if (recorded.chore_id !== context.chore.id || recorded.request_digest !== requestDigest) throw new Error('同じ操作の内容が異なります。');
    return JSON.parse(recorded.receipt_json) as PersonalSeasonalReceipt;
  }
  const previous = await readPersonalSeasonalInside(database, context.chore.id);
  if (!previous) throw new Error('対象の季節家事を初期化してください。');
  const history = await seasonalHistory(database, context.chore.id);
  let event: SeasonalEvent | null = null; let kind: PersonalSeasonalReceipt['kind'] = 'applied';
  const state = { ...previous.state, pending: { ...previous.state.pending } };
  if (operation.type === 'complete') {
    const target = works.map(work => state.pending[work]).find(round => round.id === operation.roundId);
    if (!target || !context.chore.enabled) kind = [...history.active.values()].some(event => event.roundId === operation.roundId) ? 'alreadyCompleted' : 'staleRound';
    else {
      // Both work kinds stay independent, including when their completion dates coincide.
      pinnedClockAt(0, operation.timeZone);
      if (!operation.completionId || !['personal', 'shared'].includes(operation.origin)) throw new Error('季節家事の実施記録を確認してください。');
      state.pending[target.work] = completePersonalSeasonalRound(target, { completedDate: operation.date, region: context.region, fingerprint: context.fingerprint });
      event = { seasonal: true, operationId: operation.operationId, recordedAt: operation.recordedAt, type: 'complete', completionId: operation.completionId, roundId: target.id,
        work: target.work, frozenPlan: target, date: operation.date, timeZone: operation.timeZone, origin: operation.origin };
    }
  } else {
    const target = history.events.find((event): event is SeasonalCompletion => event.type === 'complete' && event.operationId === operation.targetOperationId);
    if (!target || target.completionId !== operation.completionId) throw new Error('取り消す季節家事を確認してください。');
    if (!history.active.has(target.operationId)) kind = 'alreadyUndone';
    else {
      history.active.delete(target.operationId);
      const latest = [...history.active.values()].filter(event => event.work === target.work).at(-1);
      if (latest) state.pending[target.work] = completePersonalSeasonalRound(latest.frozenPlan, { completedDate: latest.date,
        region: context.region, fingerprint: context.fingerprint });
      else {
        const original = state.initial[target.work];
        const frozen = await database.getFirstAsync<{ plan_json: string }>('SELECT plan_json FROM personal_adaptive_plans WHERE chore_id=? AND round_id=? ORDER BY rowid DESC LIMIT 1', context.chore.id, original.id);
        const plan = frozen ? JSON.parse(frozen.plan_json) as PersonalSeasonalRound : original;
        state.pending[target.work] = updatePersonalSeasonalRegion(plan, { region: context.region, today: context.today,
          completedRoundIds: new Set(), fingerprint: context.fingerprint });
      }
      event = { seasonal: true, operationId: operation.operationId, recordedAt: operation.recordedAt, type: 'undo', completionId: operation.completionId, targetOperationId: operation.targetOperationId };
    }
  }
  const next = event ? await writeState(database, context, state, previous) : previous;
  const receipt: PersonalSeasonalReceipt = { operationId: operation.operationId, kind, revision: next.revision };
  await database.runAsync(`INSERT INTO personal_adaptive_actions(operation_id,chore_id,action_type,completion_id,round_id,target_operation_id,
    request_digest,event_json,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)`, operation.operationId, context.chore.id, event ? operation.type : 'receipt',
  operation.completionId, operation.type === 'complete' ? operation.roundId : null, operation.type === 'undo' ? operation.targetOperationId : null,
  requestDigest, event ? JSON.stringify(event) : null, JSON.stringify(receipt));
  await context.assertInputsCurrent(); return receipt;
}
export function personalSeasonalEntries(chore: ChoreDefinition, view: PersonalSeasonalView | null, today: LocalDate, assignedMemberIds: readonly string[]): ChoreScheduleEntry[] {
  if (!chore.enabled || chore.archived || !view?.state.enabled) return [];
  return works.map(work => {
    const plan = view.state.pending[work];
    return { id: plan.id, householdId: chore.householdId, choreId: chore.id, cycleBaseDate: plan.date, suggestedDate: plan.date,
      windowStart: plan.date, windowEnd: plan.date, status: today > plan.date ? 'overdue' : today === plan.date ? 'inWindow' : 'scheduled',
      seasonalWork: plan.work,
      assignedMemberIds: [...assignedMemberIds], ...(today > plan.date ? { overdueDays: daysBetween(plan.date, today) } : {}) };
  });
}
