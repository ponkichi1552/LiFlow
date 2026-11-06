import type { SQLiteDatabase } from 'expo-sqlite';
import { verifyManualContent } from '../../features/appliance-care/manual-document.ts';

/** Called inside its appliance transaction; no network, native module, or original-file deletion. */
export async function storeApplianceManualInside(database: SQLiteDatabase, content: string, expectedDigest: string): Promise<void> {
  const document = verifyManualContent(content, expectedDigest);
  await database.runAsync('INSERT OR IGNORE INTO appliance_manual_documents (sha256, byte_length, content_base64) VALUES (?, ?, ?)', document.sha256, document.byteLength, content);
}
