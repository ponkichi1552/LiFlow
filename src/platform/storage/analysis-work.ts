import type { SQLiteDatabase } from 'expo-sqlite';
import { analysisTargetKey } from '../../features/appliance-care/analysis-work.ts';
import type { AnalysisTarget, AnalysisWork, AnalysisWorkSummary, SharedAnalysisBasis } from '../../features/appliance-care/analysis-work';
import type { ApplianceCareApiRequest, ApplianceCareApiResponse } from '../../features/appliance-care/api-contracts';
import { storeApplianceManualInside } from './appliance-manual-storage.ts';
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
const work = (row: WorkRow): AnalysisWork => ({
  ...summary(row), owner: row.owner, request: JSON.parse(row.request_json), baseUrl: row.base_url,
  manualDigest: row.manual_digest, basis: row.basis_json ? JSON.parse(row.basis_json) : undefined,
  result: row.output_json ? JSON.parse(row.output_json) : null, attempts: row.attempts, retryAt: row.retry_at, createdAt: row.created_at,
});
const hasTable = async (database: SQLiteDatabase) => {
  if (existing.has(database)) return true;
  if (!await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appliance_analysis_work'")) return false;
  existing.add(database);
  return true;
};
const pendingColumns = 'id,owner,group_id,appliance_id,filename,state,request_json,base_url,manual_digest,basis_json,attempts,retry_at,created_at';

export function deviceAnalysisWork(database: SQLiteDatabase) {
  const change = async (write: () => Promise<{ changes: number }>) => {
    const result = await withPlannerDatabaseOperation(database, write);
    if (result.changes > 0) notifyAnalysisWork();
  };
  return {
    async begin(input: { owner: string; id: string; target: AnalysisTarget; baseUrl: string; filename?: string; request: ApplianceCareApiRequest; basis?: SharedAnalysisBasis }) {
      await withPlannerDatabaseOperation(database, async () => {
        if (await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_workspace_metadata'")) {
          throw new Error('解析の個人保存先を確認してください。');
        }
        if (!await hasTable(database)) {
          await database.execAsync(`CREATE TABLE IF NOT EXISTS appliance_analysis_work (
            owner TEXT NOT NULL, id TEXT NOT NULL, target TEXT NOT NULL, group_id TEXT NOT NULL, appliance_id TEXT NOT NULL,
            base_url TEXT NOT NULL, filename TEXT, request_json TEXT NOT NULL, manual_digest TEXT NOT NULL, basis_json TEXT,
            state TEXT NOT NULL, delivery_job_id TEXT, result_json TEXT, created_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(owner,id), UNIQUE(owner,target));`);
          existing.add(database);
        }
        const { manual, ...request } = input.request;
        if (!manual || manual.rightsConfirmed !== true) throw new Error('取扱説明書PDFを選んでください。');
        const target = analysisTargetKey(input.target);
        await withIsolatedSqliteTransaction(database, async transaction => {
          const previous = await transaction.getFirstAsync<{ state: string }>('SELECT state FROM appliance_analysis_work WHERE owner=? AND target=?', input.owner, target);
          if (previous?.state === 'pending') return;
          const digest = await storeApplianceManualInside(transaction, manual.base64);
          await transaction.runAsync('DELETE FROM appliance_analysis_work WHERE owner=? AND target=?', input.owner, target);
          await transaction.runAsync(`INSERT INTO appliance_analysis_work
            (owner,id,target,group_id,appliance_id,base_url,filename,request_json,manual_digest,basis_json,state,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`, input.owner, input.id, target, input.target.groupId ?? '',
          input.target.applianceId ?? '', input.baseUrl, input.filename ?? null, JSON.stringify(request), digest,
          input.basis ? JSON.stringify(input.basis) : null, Date.now());
        });
      });
      notifyAnalysisWork();
    },
    list: (owner: string, groupId?: string) => withPlannerDatabaseOperation(database, async () => {
      if (!await hasTable(database)) return [];
      const rows = await database.getAllAsync<WorkSummaryRow>(`SELECT id,group_id,appliance_id,filename,state FROM appliance_analysis_work
        WHERE owner=? AND (group_id='' OR group_id=?) ORDER BY created_at DESC`, owner, groupId ?? '');
      return rows.map(summary);
    }),
    read: (owner: string, target: AnalysisTarget) => withPlannerDatabaseOperation(database, async () => {
      if (!await hasTable(database)) return null;
      const row = await database.getFirstAsync<WorkRow & { delivery_job_id: string | null }>(`SELECT ${pendingColumns},delivery_job_id,
        result_json AS output_json FROM appliance_analysis_work WHERE owner=? AND target=?`, owner, analysisTargetKey(target));
      if (!row) return null;
      if (row.delivery_job_id) {
        const delivery = await database.getFirstAsync<{ result_json: string }>('SELECT result_json FROM appliance_analysis_deliveries WHERE owner=? AND job_id=?', owner, row.delivery_job_id);
        row.output_json = delivery?.result_json ?? null;
      }
      return work(row);
    }),
    next: (owner: string, baseUrl: string) => withPlannerDatabaseOperation(database, async () => {
      if (!await hasTable(database)) return null;
      const row = await database.getFirstAsync<WorkRow>(`SELECT ${pendingColumns},NULL AS output_json
        FROM appliance_analysis_work WHERE owner=? AND base_url=? AND state='pending' ORDER BY retry_at,created_at LIMIT 1`, owner, baseUrl);
      return row ? work(row) : null;
    }),
    async markAttempt(owner: string, id: string) {
      const result = await withPlannerDatabaseOperation(database, () => database.runAsync("UPDATE appliance_analysis_work SET attempts=attempts+1 WHERE owner=? AND id=? AND state='pending'", owner, id));
      return result.changes === 1;
    },
    retry: (owner: string, id: string, at: number) => change(() => database.runAsync(
      "UPDATE appliance_analysis_work SET retry_at=? WHERE owner=? AND id=? AND state='pending'", at, owner, id)),
    finish: (owner: string, id: string, result: ApplianceCareApiResponse) => change(() => database.runAsync(
      "UPDATE appliance_analysis_work SET state=?,result_json=?,retry_at=0 WHERE owner=? AND id=? AND state='pending'",
      result.status === 'verified' ? 'ready' : 'failed', JSON.stringify(result), owner, id)),
    remove: (owner: string, id: string) => change(() => database.runAsync("DELETE FROM appliance_analysis_work WHERE owner=? AND id=? AND state<>'pending'", owner, id)),
  };
}
