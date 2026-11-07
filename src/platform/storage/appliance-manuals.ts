import type { SQLiteDatabase } from 'expo-sqlite';
import type { Appliance } from '../../features/appliance-care/contracts';
import { verifyManualContent } from '../../features/appliance-care/manual-document.ts';
import { applianceManufacturerIdentity } from '../../features/appliance-care/official-url.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { storeApplianceManualInside } from './appliance-manual-storage.ts';
const verifiedDocuments = new WeakMap<SQLiteDatabase, { values: Map<string, string>; characters: number }>();
const MAX_VERIFIED_DOCUMENT_CHARACTERS = 12 * 1024 * 1024;
export function readApplianceManual(database: SQLiteDatabase, digest: string): Promise<string | null> {
  return withPlannerDatabaseOperation(database, async () => {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('説明書の保存先を確認してください。');
    const row = await database.getFirstAsync<{ content_base64: string }>('SELECT content_base64 FROM appliance_manual_documents WHERE sha256=?', digest);
    if (!row) return null;
    let checked = verifiedDocuments.get(database);
    if (checked?.values.get(digest) !== row.content_base64) {
      verifyManualContent(row.content_base64, digest);
      if (!checked) { checked = { values: new Map(), characters: 0 }; verifiedDocuments.set(database, checked); }
      checked.characters -= checked.values.get(digest)?.length ?? 0;
      checked.values.delete(digest); checked.values.set(digest, row.content_base64); checked.characters += row.content_base64.length;
      while (checked.characters > MAX_VERIFIED_DOCUMENT_CHARACTERS) {
        const first = checked.values.keys().next().value!; checked.characters -= checked.values.get(first)!.length; checked.values.delete(first);
      }
    }
    return row.content_base64;
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
    const byIdentity = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = JSON.stringify(identity(row.manufacturer, row.model_number)); const matches = byIdentity.get(key) ?? [];
      matches.push(row); byIdentity.set(key, matches);
    }
    const savedCopies = new Map<string, string>();
    const existingManuals = new Set<string>();
    const ids = [...new Set(copies.map(copy => copy.appliance.id))];
    const digests = [...new Set(copies.flatMap(copy => copy.manual && copy.appliance.analysis.manualSource?.sha256 ? [copy.appliance.analysis.manualSource.sha256] : []))];
    for (let offset = 0; offset < ids.length; offset += 300) {
      const page = ids.slice(offset, offset + 300);
      for (const row of await transaction.getAllAsync<{ shared_id: string; source_digest: string }>(`SELECT shared_id,source_digest FROM appliance_shared_copies WHERE group_id=? AND shared_id IN (${page.map(() => '?').join(',')})`, groupId, ...page)) savedCopies.set(row.shared_id, row.source_digest);
    }
    for (let offset = 0; offset < digests.length; offset += 300) {
      const page = digests.slice(offset, offset + 300);
      for (const row of await transaction.getAllAsync<{ sha256: string }>(`SELECT sha256 FROM appliance_manual_documents WHERE sha256 IN (${page.map(() => '?').join(',')})`, ...page)) existingManuals.add(row.sha256);
    }
    for (const { appliance, manual } of copies) {
      if (appliance.householdId !== `shared:${groupId}`) throw new Error('家電の共有元が一致しません。');
      const digest = sharedDocumentDigest(appliance);
      const savedDigest = savedCopies.get(appliance.id);
      const manualDigest = appliance.analysis.manualSource?.sha256;
      // A historical appliance can arrive before a later retained PDF. Its metadata
      // fingerprint is unchanged, but the new document still belongs in this library.
      if (manualDigest && manual && !existingManuals.has(manualDigest)) {
        await storeApplianceManualInside(transaction, manual, manualDigest); existingManuals.add(manualDigest); changed = true;
      }
      if (savedDigest === digest) continue;
      changed = true;
      const key = JSON.stringify(identity(appliance.manufacturer, appliance.modelNumber));
      const matches = byIdentity.get(key) ?? [];
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
      savedCopies.set(appliance.id, digest);
    }
    await assertAccess();
    return changed;
  }));
}
