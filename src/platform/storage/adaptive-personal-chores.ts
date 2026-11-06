import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { replayAdaptiveHistory } from '../../domain/scheduling/adaptive/history.ts';
import type { AdaptiveHistoryEvent, AdaptiveHistoryPolicy, AdaptiveHistoryState, AdaptivePriorForecast } from '../../domain/scheduling/adaptive/history';
import type { AdaptiveRoundPlacement } from '../../domain/scheduling/adaptive/placement';

type Fingerprint = (value: unknown) => string;
export type AdaptivePersonalOperation = { operationId: string; recordedAt: string } & (
  | { type: 'settings'; mode?: AdaptiveHistoryPolicy['mode']; enabled?: boolean; fixedDays?: number | null;
      initialDays?: AdaptiveHistoryPolicy['initialDays']; policyVersion?: string }
  | { type: 'complete'; completionId: string; roundId: string; planRevision: string; date: LocalDate; timeZone: string; origin: 'personal' | 'shared' }
  | { type: 'undo'; completionId: string; targetOperationId: string }
);
export interface AdaptivePersonalReceipt {
  operationId: string; revision: number; kind: 'applied' | 'alreadyCompleted' | 'alreadyUndone' | 'staleRound';
  activeRoundId: string | null; completionId?: string;
}
export interface AdaptivePersonalView {
  revision: number; state: AdaptiveHistoryState; plan: AdaptiveRoundPlacement | null; planRevision: string | null; inputRevision: string;
}
export interface AdaptivePersonalPlanning {
  today: LocalDate; now: string; inputRevision: string;
  /** Same SQLite transaction/input version as the caller's completion, definition and Google Outbox writes. */
  plan(input: { roundId: string; state: AdaptiveHistoryState; previous: AdaptiveRoundPlacement | null;
    trigger: 'initial' | 'replan' | AdaptivePersonalOperation['type'] }): Promise<AdaptiveRoundPlacement> | AdaptiveRoundPlacement;
  assertInputsCurrent(): Promise<void> | void;
}

/** Schema preparation happens during database initialization, never in a completion callback. */
export async function initializeAdaptivePersonalSchemaInside(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS personal_adaptive_policies (chore_id TEXT PRIMARY KEY NOT NULL, policy_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_adaptive_actions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL, chore_id TEXT NOT NULL,
      action_type TEXT NOT NULL, completion_id TEXT, round_id TEXT, target_operation_id TEXT,
      request_digest TEXT NOT NULL, event_json TEXT, receipt_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_personal_adaptive_actions_chore ON personal_adaptive_actions(chore_id,sequence);
    CREATE INDEX IF NOT EXISTS idx_personal_adaptive_actions_round ON personal_adaptive_actions(chore_id,round_id,action_type);
    CREATE INDEX IF NOT EXISTS idx_personal_adaptive_actions_undo ON personal_adaptive_actions(chore_id,target_operation_id,action_type);
    CREATE TABLE IF NOT EXISTS personal_adaptive_state (
      chore_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
      active_round_id TEXT, plan_revision TEXT, input_revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_adaptive_plans (
      round_id TEXT NOT NULL, revision TEXT NOT NULL, chore_id TEXT NOT NULL, plan_json TEXT NOT NULL,
      input_revision TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY(round_id,revision));
    CREATE INDEX IF NOT EXISTS idx_personal_adaptive_plans_chore ON personal_adaptive_plans(chore_id);
    CREATE TABLE IF NOT EXISTS personal_adaptive_forecasts (
      id TEXT PRIMARY KEY NOT NULL, chore_id TEXT NOT NULL, source_sequence INTEGER NOT NULL,
      round_id TEXT NOT NULL, forecast_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_personal_adaptive_forecasts_chore ON personal_adaptive_forecasts(chore_id,source_sequence);
  `);
}
function checkedScope(choreId: string) {
  if (!choreId || choreId.length > 512 || choreId.includes('\0')) throw new Error('個人家事の保存先を確認してください。');
}
async function requireTransaction(database: SQLiteDatabase) {
  if (!await database.isInTransactionAsync()) throw new Error('個人家事は完了・予定・送信待ちと同じトランザクションで保存してください。');
}
async function historyInside(database: SQLiteDatabase, choreId: string) {
  const policyRow = await database.getFirstAsync<{ policy_json: string }>('SELECT policy_json FROM personal_adaptive_policies WHERE chore_id=?', choreId);
  if (!policyRow) throw new Error('個人家事の初期設定を確認してください。');
  const policy = JSON.parse(policyRow.policy_json) as AdaptiveHistoryPolicy;
  if (policy.choreId !== choreId || policy.kind !== 'personal') throw new Error('個人家事の初期設定を確認してください。');
  const rows = await database.getAllAsync<{ sequence: number; event_json: string }>(
    'SELECT sequence,event_json FROM personal_adaptive_actions WHERE chore_id=? AND event_json IS NOT NULL ORDER BY sequence', choreId);
  const forecasts = await database.getAllAsync<{ forecast_json: string }>(
    'SELECT forecast_json FROM personal_adaptive_forecasts WHERE chore_id=? ORDER BY source_sequence,id', choreId);
  return { policy, events: rows.map(row => ({ ...JSON.parse(row.event_json), sequence: row.sequence }) as AdaptiveHistoryEvent),
    forecasts: forecasts.map(row => JSON.parse(row.forecast_json) as AdaptivePriorForecast) };
}
interface AdaptiveViewRow {
  chore_id: string; revision: number; state_json: string; active_round_id: string | null;
  plan_revision: string | null; input_revision: string; plan_json: string | null;
}
const viewQuery = `SELECT s.*,p.plan_json FROM personal_adaptive_state s LEFT JOIN personal_adaptive_plans p
  ON p.chore_id=s.chore_id AND p.round_id=s.active_round_id AND p.revision=s.plan_revision`;
function viewFromRow(row: AdaptiveViewRow): AdaptivePersonalView {
  const state = JSON.parse(row.state_json) as AdaptiveHistoryState;
  if (state.policy.choreId !== row.chore_id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('個人家事の状態を確認してください。');
  if (Boolean(row.active_round_id) !== Boolean(row.plan_json) || Boolean(row.plan_revision) !== Boolean(row.plan_json)) throw new Error('個人家事の表示済み予定を確認してください。');
  const savedPlan = row.plan_json ? JSON.parse(row.plan_json) as AdaptiveRoundPlacement : null;
  if (savedPlan && savedPlan.id !== row.active_round_id) throw new Error('個人家事の予定回を確認してください。');
  return { revision: row.revision, state, plan: savedPlan, planRevision: row.plan_revision, inputRevision: row.input_revision };
}
export async function readAdaptivePersonalInside(database: SQLiteDatabase, choreId: string): Promise<AdaptivePersonalView | null> {
  checkedScope(choreId);
  const row = await database.getFirstAsync<AdaptiveViewRow>(`${viewQuery} WHERE s.chore_id=?`, choreId);
  return row ? viewFromRow(row) : null;
}
/** One bounded projection read for a screen; no history, forecast or per-chore query fanout. */
export async function readAllAdaptivePersonalInside(database: SQLiteDatabase): Promise<Map<string, AdaptivePersonalView>> {
  const rows = await database.getAllAsync<AdaptiveViewRow>(`${viewQuery} ORDER BY s.chore_id`);
  return new Map(rows.map(row => [row.chore_id, viewFromRow(row)]));
}
export function adaptivePersonalRoundId(choreId: string, state: AdaptiveHistoryState, fingerprint: Fingerprint): string {
  return roundIdFor(choreId, state.policy.version, state.lastPlanCompletion?.operationId ?? null, fingerprint);
}
function roundIdFor(choreId: string, policyVersion: string, operationId: string | null, fingerprint: Fingerprint) {
  return `personal-round.${fingerprint(['adaptive-round-v1', choreId, operationId ?? `initial:${policyVersion}`])}`;
}
async function publishInside(database: SQLiteDatabase, choreId: string, state: AdaptiveHistoryState, previous: AdaptivePersonalView | null,
  planning: AdaptivePersonalPlanning, trigger: 'initial' | 'replan' | AdaptivePersonalOperation['type'], fingerprint: Fingerprint,
  restoreNonPeriodicRoundId?: string) {
  parseLocalDate(planning.today);
  if (!planning.inputRevision || !Number.isFinite(Date.parse(planning.now))) throw new Error('個人予定の計算版を確認してください。');
  const candidateRoundId = adaptivePersonalRoundId(choreId, state, fingerprint);
  const priorTarget = previous?.plan?.id !== candidateRoundId ? await database.getFirstAsync<{ plan_json: string }>(
    'SELECT plan_json FROM personal_adaptive_plans WHERE chore_id=? AND round_id=? ORDER BY rowid DESC LIMIT 1', choreId, candidateRoundId) : null;
  const restored = priorTarget ? JSON.parse(priorTarget.plan_json) as AdaptiveRoundPlacement : previous?.plan ?? null;
  const alreadyHeld = previous?.state.model === null && previous.plan?.id === candidateRoundId;
  const newlyProtected = trigger === 'settings' && previous?.plan?.id === candidateRoundId
    && previous.plan.recommendedDate >= planning.today && previous.plan.recommendedDate <= addDays(planning.today, 1);
  const restoringHeld = trigger === 'undo' && restoreNonPeriodicRoundId === candidateRoundId && restored?.id === candidateRoundId;
  const protectedNonPeriodic = state.policy.enabled && state.model === null && (alreadyHeld || newlyProtected || restoringHeld);
  const canPlan = state.policy.enabled && (state.model !== null || protectedNonPeriodic);
  const roundId = canPlan ? candidateRoundId : null;
  const plan = roundId ? protectedNonPeriodic ? restored! : await planning.plan({ roundId, state,
    previous: restored?.id === roundId ? restored : null, trigger }) : null;
  if (plan) {
    for (const date of [plan.originalBaseDate, plan.placedBaseDate, plan.recommendedDate]) parseLocalDate(date);
    for (const window of [plan.basicWindow, plan.displayedWindow]) if (window) {
      parseLocalDate(window.from); parseLocalDate(window.through); if (window.from > window.through) throw new Error('家事の実施期間を確認してください。');
    }
    if (plan.slot && (!Number.isFinite(plan.slot.start) || !Number.isFinite(plan.slot.end) || plan.slot.start >= plan.slot.end)) throw new Error('家事の実施時間を確認してください。');
  }
  if (plan && (plan.id !== roundId || plan.displayedWindow && (plan.recommendedDate < plan.displayedWindow.from || plan.recommendedDate > plan.displayedWindow.through)
    || state.lastPlanCompletion && plan.recommendedDate <= state.lastPlanCompletion.date)) throw new Error('次回予定と実施期間を確認してください。');
  const planRevision = plan ? fingerprint(['adaptive-plan-v1', choreId, plan]) : null;
  await planning.assertInputsCurrent();
  if (plan) await database.runAsync(`INSERT INTO personal_adaptive_plans VALUES(?,?,?,?,?,?) ON CONFLICT(round_id,revision) DO NOTHING`,
    roundId, planRevision, choreId, JSON.stringify(plan), planning.inputRevision, planning.now);
  const revision = (previous?.revision ?? 0) + 1;
  // Keep the display projection small. Original events and prior forecasts are
  // retained separately; ordinary screen reads never replay either collection.
  const projection = { ...state, scores: state.scores.slice(-15), issues: state.issues.slice(-10), forecast: null };
  const saved = previous
    ? await database.runAsync(`UPDATE personal_adaptive_state SET revision=?,state_json=?,active_round_id=?,plan_revision=?,input_revision=?
      WHERE chore_id=? AND revision=?`, revision, JSON.stringify(projection), roundId, planRevision, planning.inputRevision, choreId, previous.revision)
    : await database.runAsync('INSERT INTO personal_adaptive_state VALUES(?,?,?,?,?,?)', choreId, revision, JSON.stringify(projection), roundId, planRevision, planning.inputRevision);
  if (saved.changes !== 1) throw new Error('別の操作で個人予定が更新されました。');
  return { revision, roundId, plan, planRevision };
}

/** Caller owns one transaction for initialization/model/plan and its normal definition writes. */
export async function initializeAdaptivePersonalChoreInside(database: SQLiteDatabase, policy: AdaptiveHistoryPolicy,
  planning: AdaptivePersonalPlanning, fingerprint: Fingerprint): Promise<AdaptivePersonalView> {
  checkedScope(policy.choreId);
  await requireTransaction(database);
  if (policy.kind !== 'personal') throw new Error('共有・季節・表示専用家事は専用の計算を使ってください。');
  const old = await readAdaptivePersonalInside(database, policy.choreId);
  if (old) return old;
  const state = replayAdaptiveHistory({ policy, events: [], forecasts: [], fingerprint });
  await database.runAsync('INSERT INTO personal_adaptive_policies VALUES(?,?)', policy.choreId, JSON.stringify(policy));
  await publishInside(database, policy.choreId, state, null, planning, 'initial', fingerprint);
  return (await readAdaptivePersonalInside(database, policy.choreId))!;
}

/** Calendar/weather changes use the small current model; no history or model fitting is repeated. */
export async function replanAdaptivePersonalInside(database: SQLiteDatabase, choreId: string,
  planning: AdaptivePersonalPlanning, fingerprint: Fingerprint): Promise<AdaptivePersonalView> {
  checkedScope(choreId); await requireTransaction(database);
  const current = await readAdaptivePersonalInside(database, choreId); if (!current) throw new Error('個人家事を初期化してください。');
  if (current.inputRevision === planning.inputRevision) return current;
  await publishInside(database, choreId, current.state, current, planning, 'replan', fingerprint);
  return (await readAdaptivePersonalInside(database, choreId))!;
}

/** Never call without the surrounding completion/Google-intent transaction. No network request occurs here. */
export async function applyAdaptivePersonalOperationInside(database: SQLiteDatabase, choreId: string, operation: AdaptivePersonalOperation,
  planning: AdaptivePersonalPlanning, fingerprint: Fingerprint): Promise<AdaptivePersonalReceipt> {
  checkedScope(choreId);
  await requireTransaction(database);
  if (!operation.operationId || operation.operationId.length > 512 || !Number.isFinite(Date.parse(operation.recordedAt))) throw new Error('個人家事の操作を確認してください。');
  const digest = fingerprint([choreId, operation]);
  const receiptRow = await database.getFirstAsync<{ chore_id: string; request_digest: string; receipt_json: string }>(
    'SELECT chore_id,request_digest,receipt_json FROM personal_adaptive_actions WHERE operation_id=?', operation.operationId);
  if (receiptRow) {
    if (receiptRow.chore_id !== choreId || receiptRow.request_digest !== digest) throw new Error('同じ操作の内容が異なります。');
    return JSON.parse(receiptRow.receipt_json) as AdaptivePersonalReceipt;
  }
  const current = await readAdaptivePersonalInside(database, choreId); if (!current) throw new Error('個人家事を初期化してください。');
  async function finishWithoutEvent(kind: AdaptivePersonalReceipt['kind'], completionId?: string) {
    const receipt: AdaptivePersonalReceipt = { operationId: operation.operationId, revision: current!.revision, kind,
      activeRoundId: current!.plan?.id ?? null, ...(completionId ? { completionId } : {}) };
    await database.runAsync(`INSERT INTO personal_adaptive_actions(operation_id,chore_id,action_type,request_digest,receipt_json)
      VALUES(?,?,'receipt',?,?)`, operation.operationId, choreId, digest, JSON.stringify(receipt)); return receipt;
  }
  let event: Omit<AdaptiveHistoryEvent, 'sequence'>; let restoreNonPeriodicRoundId: string | undefined;
  if (operation.type === 'complete') {
    if (!operation.completionId || !operation.roundId || !operation.planRevision) throw new Error('実施対象の家事回を確認してください。');
    if (!current.plan || current.plan.id !== operation.roundId) {
      const done = await database.getFirstAsync<{ completion_id: string }>(`SELECT completion_id FROM personal_adaptive_actions a WHERE a.chore_id=?
        AND a.round_id=? AND a.action_type='complete' AND NOT EXISTS(SELECT 1 FROM personal_adaptive_actions u WHERE
        u.chore_id=a.chore_id AND u.action_type='undo' AND u.target_operation_id=a.operation_id) ORDER BY a.sequence DESC LIMIT 1`, choreId, operation.roundId);
      return finishWithoutEvent(done ? 'alreadyCompleted' : 'staleRound', done?.completion_id);
    }
    const frozen = await database.getFirstAsync<{ plan_json: string }>('SELECT plan_json FROM personal_adaptive_plans WHERE chore_id=? AND round_id=? AND revision=?', choreId, operation.roundId, operation.planRevision);
    const plan = frozen ? JSON.parse(frozen.plan_json) as AdaptiveRoundPlacement : null;
    event = { operationId: operation.operationId, recordedAt: operation.recordedAt, type: 'complete', completionId: operation.completionId,
      roundId: operation.roundId, localDate: operation.date, timeZone: operation.timeZone, origin: operation.origin,
      mode: current.state.policy.mode, initialDays: current.state.policy.initialDays[current.state.policy.mode],
      displayedWindow: plan ? plan.displayedWindow ? { revision: operation.planRevision, ...plan.displayedWindow } : null : 'missing',
      ...(plan ? { ruleDate: plan.originalBaseDate } : {}) } as Omit<AdaptiveHistoryEvent, 'sequence'>;
  } else if (operation.type === 'undo') {
    const target = await database.getFirstAsync<{ completion_id: string; round_id: string; event_json: string; undone: number }>(`SELECT a.completion_id,a.round_id,a.event_json,
      EXISTS(SELECT 1 FROM personal_adaptive_actions u WHERE u.chore_id=a.chore_id AND u.action_type='undo'
      AND u.target_operation_id=a.operation_id) AS undone FROM personal_adaptive_actions a WHERE a.chore_id=? AND a.operation_id=? AND a.action_type='complete'`,
    choreId, operation.targetOperationId);
    if (!target || target.completion_id !== operation.completionId) throw new Error('取り消す個人家事を確認してください。');
    if (target.undone) return finishWithoutEvent('alreadyUndone', operation.completionId);
    if (JSON.parse(target.event_json).initialDays === null) restoreNonPeriodicRoundId = target.round_id;
    event = { ...operation };
  } else event = { ...operation };
  const inserted = await database.runAsync(`INSERT INTO personal_adaptive_actions(operation_id,chore_id,action_type,completion_id,round_id,
    target_operation_id,request_digest,event_json,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)`,
  operation.operationId, choreId, operation.type, 'completionId' in operation ? operation.completionId : null,
  operation.type === 'complete' ? operation.roundId : null, operation.type === 'undo' ? operation.targetOperationId : null,
  digest, JSON.stringify(event), '{}');
  const sequence = inserted.lastInsertRowId;
  const history = await historyInside(database, choreId);
  const state = replayAdaptiveHistory({ ...history, fingerprint, capture: { afterOperationId: operation.operationId,
    forRoundId: operationId => roundIdFor(choreId, history.policy.version, operationId, fingerprint), createdAt: planning.now } });
  const next = await publishInside(database, choreId, state, current, planning, operation.type, fingerprint, restoreNonPeriodicRoundId);
  if (next.roundId) {
    const captured = state.forecast;
    if (captured && captured.forRoundId !== next.roundId) throw new Error('次回予定と事前予測の対応を確認してください。');
    if (captured) await database.runAsync('INSERT INTO personal_adaptive_forecasts VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      captured.id, choreId, sequence, next.roundId, JSON.stringify(captured));
  }
  await planning.assertInputsCurrent();
  const receipt: AdaptivePersonalReceipt = { operationId: operation.operationId, revision: next.revision, kind: 'applied',
    activeRoundId: next.roundId, ...('completionId' in operation ? { completionId: operation.completionId } : {}) };
  await database.runAsync('UPDATE personal_adaptive_actions SET receipt_json=? WHERE operation_id=? AND chore_id=?', JSON.stringify(receipt), operation.operationId, choreId);
  return receipt;
}
