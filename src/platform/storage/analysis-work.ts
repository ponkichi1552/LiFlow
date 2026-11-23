import type { SQLiteDatabase } from 'expo-sqlite';
import { analysisTargetKey } from '../../features/appliance-care/analysis-work.ts';
import type { AnalysisTarget, AnalysisWork, AnalysisWorkSummary, AnalysisWorkBasis } from '../../features/appliance-care/analysis-work';
import type { ApplianceCareApiRequest, ApplianceCareApiResponse } from '../../features/appliance-care/api-contracts';
import { removeUnreferencedApplianceManualInside, storeApplianceManualInside } from './appliance-manual-storage.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { withPlannerDatabaseOperation } from './repository.ts';

interface WorkSummaryRow {
  id: string;
  group_id: string;
  appliance_id: string;
  filename: string | null;
  state: AnalysisWorkSummary['state'];
}
interface WorkRow extends WorkSummaryRow {
  owner: string;
  request_json: string;
  base_url: string;
  manual_digest: string;
  basis_json: string | null;
  output_json: string | null;
  attempts: number;
  retry_at: number;
  created_at: number;
  first_attempt_at: number | null;
}

const listeners = new Set<() => void>();
const existing = new WeakSet<SQLiteDatabase>();
export function notifyAnalysisWork() {
  for (const listener of listeners) { try { listener(); } catch { /* A listener cannot undo a committed result. */ } }
}
export function subscribeAnalysisWork(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const summary = (row: WorkSummaryRow): AnalysisWorkSummary => ({
  id: row.id, groupId: row.group_id || undefined, applianceId: row.appliance_id || undefined,
  filename: row.filename ?? undefined, state: row.state,
});
const invalidSavedWork: ApplianceCareApiResponse = { status: 'error', code: 'INVALID_REQUEST', message: '保存した解析を読み込めません。PDFを選び直してください。' };
const changedEndpoint: ApplianceCareApiResponse = { status: 'error', code: 'JOB_NOT_FOUND', message: '家電AIの接続先が変わりました。PDFを選び直してください。' };
function parseRecord<T>(json: string): T {
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Invalid stored analysis record');
  return value as T;
}
const workMetadata = (row: WorkRow) => ({ ...summary(row), owner: row.owner, baseUrl: row.base_url,
  manualDigest: row.manual_digest, attempts: row.attempts, retryAt: row.retry_at, createdAt: row.created_at,
  firstAttemptAt: row.first_attempt_at ?? undefined });
const work = (row: WorkRow): AnalysisWork => ({
  ...workMetadata(row), request: parseRecord(row.request_json), basis: row.basis_json ? parseRecord(row.basis_json) : undefined,
  result: row.output_json ? parseRecord(row.output_json) : null,
});
const hasTable = async (database: SQLiteDatabase) => {
  if (existing.has(database)) return true;
  if (!await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appliance_analysis_work'")) return false;
  existing.add(database);
  return true;
};
const pendingColumns = 'id,owner,group_id,appliance_id,filename,state,request_json,base_url,manual_digest,basis_json,attempts,retry_at,created_at,first_attempt_at';

export function deviceAnalysisWork(database: SQLiteDatabase) {
  const change = async (write: () => Promise<{ changes: number }>) => {
    const result = await withPlannerDatabaseOperation(database, write);
    if (result.changes > 0) notifyAnalysisWork();
  };
  return {
    async begin(input: { owner: string; id: string; target: AnalysisTarget; baseUrl: string; filename?: string; request: ApplianceCareApiRequest; basis?: AnalysisWorkBasis }) {
      const saved = await withPlannerDatabaseOperation(database, async () => {
        if (await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_workspace_metadata'")) {
          throw new Error('解析の個人保存先を確認してください。');
        }
        if (!await hasTable(database)) {
          await database.execAsync(`CREATE TABLE IF NOT EXISTS appliance_analysis_work (
            owner TEXT NOT NULL, id TEXT NOT NULL, target TEXT NOT NULL, group_id TEXT NOT NULL, appliance_id TEXT NOT NULL,
            base_url TEXT NOT NULL, filename TEXT, request_json TEXT NOT NULL, manual_digest TEXT NOT NULL, basis_json TEXT,
            state TEXT NOT NULL, delivery_job_id TEXT, result_json TEXT, created_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER,
            PRIMARY KEY(owner,id), UNIQUE(owner,target));`);
          existing.add(database);
        }
        const { manual, ...request } = input.request;
        if (!manual || manual.rightsConfirmed !== true) throw new Error('取扱説明書PDFを選んでください。');
        const target = analysisTargetKey(input.target);
        return withIsolatedSqliteTransaction(database, async transaction => {
          const previous = await transaction.getFirstAsync<{ id: string; state: string; manual_digest: string }>(
            'SELECT id,state,manual_digest FROM appliance_analysis_work WHERE owner=? AND target=?', input.owner, target);
          if (previous?.state === 'pending') return { id: previous.id, created: false };
          const digest = await storeApplianceManualInside(transaction, manual.base64);
          await transaction.runAsync('DELETE FROM appliance_analysis_work WHERE owner=? AND target=?', input.owner, target);
          await transaction.runAsync(`INSERT INTO appliance_analysis_work
            (owner,id,target,group_id,appliance_id,base_url,filename,request_json,manual_digest,basis_json,state,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`, input.owner, input.id, target, input.target.groupId ?? '',
          input.target.applianceId ?? '', input.baseUrl, input.filename ?? null, JSON.stringify(request), digest,
          input.basis ? JSON.stringify(input.basis) : null, Date.now());
          if (previous && previous.manual_digest !== digest) await removeUnreferencedApplianceManualInside(transaction, previous.manual_digest);
          return { id: input.id, created: true };
        });
      });
      if (saved.created) notifyAnalysisWork();
      return saved.id;
    },
    list: (owner: string, groupId?: string) => withPlannerDatabaseOperation(database, async () => {
      if (!await hasTable(database)) return [];
      const rows = await database.getAllAsync<WorkSummaryRow>(`SELECT id,group_id,appliance_id,filename,state FROM appliance_analysis_work
        WHERE owner=? AND (group_id='' OR group_id=?) ORDER BY created_at DESC`, owner, groupId ?? '');
      return rows.map(summary);
    }),
    hasPending: (owner: string) => withPlannerDatabaseOperation(database, async () => {
      if (!await hasTable(database)) return false;
      return Boolean(await database.getFirstAsync("SELECT 1 FROM appliance_analysis_work WHERE owner=? AND state='pending' LIMIT 1", owner));
    }),
    read: (owner: string, target: AnalysisTarget, id?: string) => withPlannerDatabaseOperation(database, async (): Promise<AnalysisWork | null> => {
      if (!await hasTable(database)) return null;
      const row = await database.getFirstAsync<WorkRow & { delivery_job_id: string | null }>(`SELECT ${pendingColumns},delivery_job_id,
        result_json AS output_json FROM appliance_analysis_work WHERE owner=? AND target=?${id === undefined ? '' : ' AND id=?'}`,
      owner, analysisTargetKey(target), ...(id === undefined ? [] : [id]));
      if (!row) return null;
      if (row.delivery_job_id) {
        const delivery = await database.getFirstAsync<{ result_json: string }>('SELECT result_json FROM appliance_analysis_deliveries WHERE owner=? AND job_id=?', owner, row.delivery_job_id);
        row.output_json = delivery?.result_json ?? null;
      }
      try { return work(row); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { ...workMetadata(row), request: { identifyFromManual: true }, state: 'failed', result: invalidSavedWork };
      }
    }),
    async next(owner: string, baseUrl: string) {
      let changed = false;
      const read = await withPlannerDatabaseOperation(database, async () => {
        if (!await hasTable(database)) return null;
        const retired = await database.runAsync("UPDATE appliance_analysis_work SET state='failed',result_json=?,retry_at=0 WHERE owner=? AND base_url<>? AND state='pending'",
          JSON.stringify(changedEndpoint), owner, baseUrl);
        changed = retired.changes > 0;
        for (;;) {
          const row = await database.getFirstAsync<WorkRow>(`SELECT ${pendingColumns},NULL AS output_json
            FROM appliance_analysis_work WHERE owner=? AND base_url=? AND state='pending' ORDER BY retry_at,created_at LIMIT 1`, owner, baseUrl);
          if (!row) return null;
          try { return work(row); }
          catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            const failed = await database.runAsync("UPDATE appliance_analysis_work SET state='failed',result_json=?,retry_at=0 WHERE owner=? AND id=? AND state='pending'",
              JSON.stringify(invalidSavedWork), owner, row.id);
            changed ||= failed.changes > 0;
          }
        }
      });
      if (changed) notifyAnalysisWork();
      return read;
    },
    async markAttempt(owner: string, id: string) {
      const result = await withPlannerDatabaseOperation(database, () => database.runAsync(`UPDATE appliance_analysis_work SET attempts=attempts+1,
        first_attempt_at=CASE WHEN attempts=0 THEN ? ELSE first_attempt_at END WHERE owner=? AND id=? AND state='pending'`, Date.now(), owner, id));
      return result.changes === 1;
    },
    retry: (owner: string, id: string, at: number) => change(() => database.runAsync(
      "UPDATE appliance_analysis_work SET retry_at=? WHERE owner=? AND id=? AND state='pending'", at, owner, id)),
    finish: (owner: string, id: string, result: ApplianceCareApiResponse) => change(() => database.runAsync(
      "UPDATE appliance_analysis_work SET state=?,result_json=?,retry_at=0 WHERE owner=? AND id=? AND state='pending'",
      result.status === 'verified' ? 'ready' : 'failed', JSON.stringify(result), owner, id)),
    remove: (owner: string, id: string) => change(async () => {
      if (!await hasTable(database)) return { changes: 0 };
      return withIsolatedSqliteTransaction(database, async transaction => {
        const work = await transaction.getFirstAsync<{ manual_digest: string }>(
          "SELECT manual_digest FROM appliance_analysis_work WHERE owner=? AND id=? AND state<>'pending'", owner, id);
        if (!work) return { changes: 0 };
        const result = await transaction.runAsync("DELETE FROM appliance_analysis_work WHERE owner=? AND id=? AND state<>'pending'", owner, id);
        if (result.changes) await removeUnreferencedApplianceManualInside(transaction, work.manual_digest);
        return result;
      });
    }),
  };
}
