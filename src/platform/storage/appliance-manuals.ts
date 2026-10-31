import type { SQLiteDatabase } from 'expo-sqlite';
import type { Appliance } from '../../features/appliance-care/contracts';
import { prepareManualDocument } from '../../features/appliance-care/manual-document.ts';
import { applianceManufacturerIdentity } from '../../features/appliance-care/official-url.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { storeApplianceManualInside } from './appliance-manual-storage.ts';
export function readApplianceManual(database: SQLiteDatabase, digest: string): Promise<string | null> {
  return withPlannerDatabaseOperation(database, async () => {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('説明書の保存先を確認してください。');
    const row = await database.getFirstAsync<{ content_base64: string }>('SELECT content_base64 FROM appliance_manual_documents WHERE sha256=?', digest);
    if (!row) return null;
    prepareManualDocument(row.content_base64, digest); return row.content_base64;
  });
}
export interface SharedApplianceCopy { appliance: Appliance; manual: string | null }
const identity = (maker: string, model: string) => [applianceManufacturerIdentity(maker) ?? maker.normalize('NFKC').trim().toLocaleLowerCase('en-US'), model.normalize('NFKC').trim().toLocaleLowerCase('en-US')];

/** Retain the appliance, not another set of chores. Group exit/removal does not erase this personal copy. */
export function retainSharedApplianceCopies(database: SQLiteDatabase, groupId: string, copies: readonly SharedApplianceCopy[], assertAccess: () => void | Promise<void>): Promise<boolean> {
  return withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, async transaction => {
    let changed = false;
    await assertAccess();
    if (await transaction.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_workspace_metadata'")) throw new Error('家電の個人保存先を確認してください。');
    const rows = await transaction.getAllAsync<{ id: string; manufacturer: string; model_number: string; display_name: string; created_at: string }>('SELECT id, manufacturer, model_number, display_name, created_at FROM appliances WHERE household_id=?', 'local-household');
    for (const { appliance, manual } of copies) {
      if (appliance.householdId !== `shared:${groupId}`) throw new Error('家電の共有元が一致しません。');
      const digest = sharedDocumentDigest(appliance);
      const saved = await transaction.getFirstAsync<{ source_digest: string }>('SELECT source_digest FROM appliance_shared_copies WHERE group_id=? AND shared_id=?', groupId, appliance.id);
      const manualDigest = appliance.analysis.manualSource?.sha256;
      // A historical appliance can arrive before a later retained PDF. Its metadata
      // fingerprint is unchanged, but the new document still belongs in this library.
      if (manualDigest && manual && !await transaction.getFirstAsync('SELECT 1 FROM appliance_manual_documents WHERE sha256=?', manualDigest)) {
        await storeApplianceManualInside(transaction, manual, manualDigest); changed = true;
      }
      if (saved?.source_digest === digest) continue;
      changed = true;
      const key = JSON.stringify(identity(appliance.manufacturer, appliance.modelNumber));
      const matches = rows.filter(row => JSON.stringify(identity(row.manufacturer, row.model_number)) === key);
      // Historical duplicate products stay recoverable. Do not overwrite an arbitrary one.
      const prior = matches.length === 1 ? matches[0] : undefined;
      const id = prior?.id ?? `retained-appliance.${sharedDocumentDigest(identity(appliance.manufacturer, appliance.modelNumber))}`;
      await assertAccess();
      await transaction.runAsync(`INSERT INTO appliances (id, household_id, manufacturer, product_name, model_number, category, display_name,
        official_product_url, official_manual_url, analysis_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET product_name=excluded.product_name, category=excluded.category, official_product_url=excluded.official_product_url,
        official_manual_url=excluded.official_manual_url, analysis_json=excluded.analysis_json, updated_at=excluded.updated_at`,
      id, 'local-household', appliance.manufacturer, appliance.productName, appliance.modelNumber, appliance.category ?? null, prior?.display_name ?? appliance.displayName,
      appliance.officialProductUrl ?? null, appliance.officialManualUrl, JSON.stringify(appliance.analysis), prior?.created_at ?? appliance.createdAt, appliance.updatedAt);
      await transaction.runAsync('INSERT INTO appliance_shared_copies (group_id, shared_id, personal_id, source_digest) VALUES (?, ?, ?, ?) ON CONFLICT(group_id, shared_id) DO UPDATE SET personal_id=excluded.personal_id, source_digest=excluded.source_digest', groupId, appliance.id, id, digest);
    }
    await assertAccess();
    return changed;
  }));
}
