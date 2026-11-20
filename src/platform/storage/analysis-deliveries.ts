import type { SQLiteDatabase } from 'expo-sqlite';
import type { ApplianceCareApiResponse } from '../../features/appliance-care/api-contracts';
import type { AnalysisDeliveryStore, SavedAnalysisDelivery } from '../../features/appliance-care/analysis-delivery';
import { storeApplianceManualInside } from './appliance-manual-storage.ts';
import { withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';

const initialized = new WeakSet<SQLiteDatabase>();
export interface DeviceAnalysisDeliveryStore extends AnalysisDeliveryStore {
  hasPending(): Promise<boolean>; subscribe(listener: () => void): () => void;
}
const stores = new WeakMap<SQLiteDatabase, DeviceAnalysisDeliveryStore>();
/** A transport inbox, separate from registering/replacing the user's appliance or chores. */
export function deviceAnalysisDeliveries(database: SQLiteDatabase): DeviceAnalysisDeliveryStore {
  const previous = stores.get(database); if (previous) return previous;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* Other consumers must still receive a committed change. */ } } };
  const operation = <T>(work: () => Promise<T>) => withPlannerDatabaseOperation(database, async () => {
    if (!initialized.has(database)) {
      if (await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_workspace_metadata'")) throw new Error('解析結果の個人保存先を確認してください。');
      await database.execAsync(`CREATE TABLE IF NOT EXISTS appliance_analysis_deliveries (
        owner TEXT NOT NULL, job_id TEXT NOT NULL, request_key TEXT NOT NULL, base_url TEXT NOT NULL,
        receipt_json TEXT, result_json TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(owner,job_id));
        CREATE INDEX IF NOT EXISTS idx_analysis_delivery_request ON appliance_analysis_deliveries(owner,request_key,saved_at);
        CREATE TABLE IF NOT EXISTS appliance_analysis_admissions (owner TEXT NOT NULL,request_key TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,job_id TEXT,PRIMARY KEY(owner,request_key));`);
      const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(appliance_analysis_admissions)');
      if (!columns.some(column => column.name === 'job_id')) {
        await database.execAsync('ALTER TABLE appliance_analysis_admissions ADD COLUMN job_id TEXT');
      }
      initialized.add(database);
    }
    return work();
  });
  const result: DeviceAnalysisDeliveryStore = {
    hasPending: () => withPlannerDatabaseOperation(database, async () => {
      if (!await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appliance_analysis_deliveries'")) return false;
      return Boolean(await database.getFirstAsync('SELECT 1 FROM appliance_analysis_deliveries WHERE receipt_json IS NOT NULL LIMIT 1'));
    }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    admission: (owner, requestKey, proposed) => operation(() => withIsolatedSqliteTransaction(database, async transaction => {
      await transaction.runAsync('INSERT OR IGNORE INTO appliance_analysis_admissions(owner,request_key,idempotency_key) VALUES(?,?,?)', owner, requestKey, proposed);
      const row = await transaction.getFirstAsync<{ idempotency_key: string; job_id: string | null }>(
        'SELECT idempotency_key,job_id FROM appliance_analysis_admissions WHERE owner=? AND request_key=?', owner, requestKey);
      if (!row) throw new Error('解析の受付情報を端末に保存できませんでした。');
      return { id: row.idempotency_key, jobId: row.job_id };
    })),
    recordJob: (owner, requestKey, id, jobId) => operation(async () => {
      await database.runAsync('UPDATE appliance_analysis_admissions SET job_id=? WHERE owner=? AND request_key=? AND idempotency_key=? AND job_id IS NULL',
        jobId, owner, requestKey, id);
    }),
    completeAdmission: (owner, requestKey, id) => operation(async () => {
      await database.runAsync('DELETE FROM appliance_analysis_admissions WHERE owner=? AND request_key=? AND idempotency_key=?', owner, requestKey, id);
    }),
    read: (owner, requestKey) => operation(async () => {
      const row = await database.getFirstAsync<{ result_json: string }>(
        'SELECT result_json FROM appliance_analysis_deliveries WHERE owner=? AND request_key=? ORDER BY rowid DESC LIMIT 1', owner, requestKey);
      return row ? JSON.parse(row.result_json) as ApplianceCareApiResponse : null;
    }),
    save: (owner, requestKey, delivery, result, manual) => operation(() => withIsolatedSqliteTransaction(database, async transaction => {
      if (manual) await storeApplianceManualInside(transaction, manual.base64,
        result.status === 'verified' ? result.analysis.manualSource?.sha256 : undefined);
      await transaction.runAsync(`INSERT INTO appliance_analysis_deliveries(owner,job_id,request_key,base_url,receipt_json,result_json,saved_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,job_id) DO UPDATE SET receipt_json=excluded.receipt_json,result_json=excluded.result_json`,
      owner, delivery.jobId, requestKey, delivery.baseUrl, JSON.stringify(delivery.receipt), JSON.stringify(result), Date.now());
    })).then(() => { notify(); }),
    pending: owner => operation(async () => {
      const rows = await database.getAllAsync<{ job_id: string; base_url: string; receipt_json: string }>(
        'SELECT job_id,base_url,receipt_json FROM appliance_analysis_deliveries WHERE owner=? AND receipt_json IS NOT NULL ORDER BY saved_at LIMIT 32', owner);
      return rows.map(row => ({ jobId: row.job_id, baseUrl: row.base_url, receipt: JSON.parse(row.receipt_json) })) as SavedAnalysisDelivery[];
    }),
    acknowledged: (owner, jobId) => operation(async () => {
      await database.runAsync('UPDATE appliance_analysis_deliveries SET receipt_json=NULL WHERE owner=? AND job_id=?', owner, jobId);
    }).then(() => { notify(); }),
  };
  stores.set(database, result); return result;
}
