import type { SQLiteDatabase } from 'expo-sqlite';
import { verifyManualContent } from '../../features/appliance-care/manual-document.ts';

/** Called inside its appliance transaction; no network, native module, or original-file deletion. */
export async function storeApplianceManualInside(database: SQLiteDatabase, content: string, expectedDigest?: string): Promise<string> {
  const document = verifyManualContent(content, expectedDigest);
  await database.runAsync(`INSERT INTO appliance_manual_documents (sha256, byte_length, content_base64) VALUES (?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET byte_length=excluded.byte_length,content_base64=excluded.content_base64
    WHERE byte_length<>excluded.byte_length OR content_base64<>excluded.content_base64`, document.sha256, document.byteLength, content);
  return document.sha256;
}

/** Check all local references in the same transaction that removed one. */
export async function removeUnreferencedApplianceManualInside(database: SQLiteDatabase, digest: string) {
  const hasWork = await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appliance_analysis_work'");
  await database.runAsync(`DELETE FROM appliance_manual_documents WHERE sha256=?
    ${hasWork ? 'AND NOT EXISTS (SELECT 1 FROM appliance_analysis_work WHERE manual_digest=appliance_manual_documents.sha256)' : ''}
    AND NOT EXISTS (SELECT 1 FROM appliance_shared_copies WHERE manual_digest IS NULL OR manual_digest=appliance_manual_documents.sha256)
    AND NOT EXISTS (SELECT 1 FROM appliances WHERE CASE WHEN json_valid(analysis_json)
      THEN json_extract(analysis_json, '$.manualSource.sha256')=appliance_manual_documents.sha256 ELSE 1 END)`, digest);
}
