import type { SQLiteDatabase } from 'expo-sqlite';
import { verifyManualContent } from '../../features/appliance-care/manual-document.ts';

/** Called inside its appliance transaction; no network, native module, or original-file deletion. */
export async function storeApplianceManualInside(database: SQLiteDatabase, content: string, expectedDigest: string): Promise<void> {
  const document = verifyManualContent(content, expectedDigest);
  await database.runAsync(`INSERT INTO appliance_manual_documents (sha256, byte_length, content_base64) VALUES (?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET byte_length=excluded.byte_length,content_base64=excluded.content_base64
    WHERE byte_length<>excluded.byte_length OR content_base64<>excluded.content_base64`, document.sha256, document.byteLength, content);
}
