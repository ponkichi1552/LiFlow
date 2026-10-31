import { createStartupDisplayCache } from '../../features/planner/startup-display.ts';
import { nativeSharingCrypto } from './native-crypto.ts';
import { sharingSecureVault } from './secure-store.ts';
import { readSharingSelection, sharingRegistryDatabase } from './workspaces.ts';
import { readSharingWorkspace } from '../storage/sharing-registry.ts';

let initialization: Promise<void> | undefined;
async function database() {
  const db = await sharingRegistryDatabase();
  if (!initialization) {
    initialization = db.execAsync(`CREATE TABLE IF NOT EXISTS sharing_startup_display (
      user_id TEXT NOT NULL, group_id TEXT NOT NULL, encrypted_json TEXT NOT NULL, PRIMARY KEY(user_id, group_id));`);
    void initialization.catch(() => { initialization = undefined; });
  }
  await initialization; return db;
}
const keys = new Map<string, Promise<Uint8Array | null>>();
async function key(userId: string, create: boolean) {
  const pending = keys.get(userId); if (pending) return pending;
  const task = (async () => {
    const name = `startup-display-key:${userId}`;
    const saved = await sharingSecureVault.getItem(name);
    if (saved !== null) {
      if (!/^[a-f0-9]{64}$/u.test(saved)) return null;
      return new Uint8Array(saved.match(/../gu)!.map(part => parseInt(part, 16)));
    }
    if (!create) return null;
    const bytes = await nativeSharingCrypto.randomBytes(32); if (bytes.length !== 32) return null;
    await sharingSecureVault.setItem(name, Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''));
    return bytes;
  })();
  keys.set(userId, task);
  try { return await task; } finally { if (keys.get(userId) === task) keys.delete(userId); }
}
export const startupDisplayCache = createStartupDisplayCache({ crypto: nativeSharingCrypto, key,
  read: async (userId, groupId) => (await (await database()).getFirstAsync<{ encrypted_json: string }>(
    'SELECT encrypted_json FROM sharing_startup_display WHERE user_id=? AND group_id=?', userId, groupId))?.encrypted_json ?? null,
  write: async (userId, groupId, value) => { await (await database()).runAsync(`INSERT INTO sharing_startup_display VALUES (?, ?, ?)
    ON CONFLICT(user_id, group_id) DO UPDATE SET encrypted_json=excluded.encrypted_json`, userId, groupId, value); },
});

/** Historical left/removed groups cannot make the personal home wait for Firebase. */
export async function canShowPersonalStartup() {
  try {
    if (await readSharingSelection()) return false;
    const db = await sharingRegistryDatabase();
    if (await db.getFirstAsync(`SELECT 1 AS present FROM sharing_workspaces
      WHERE json_extract(record_json, '$.status') IS NULL
        OR json_extract(record_json, '$.status') NOT IN ('left','removed') LIMIT 1`)) return false;
    return !await readSharingSelection();
  } catch { return false; }
}

/** Restore the last verified local view while Firebase initializes. No live session or authority is created here. */
export async function readSavedStartupDisplay() {
  const selection = await readSharingSelection(); if (!selection) return;
  const db = await sharingRegistryDatabase();
  const current = await db.getFirstAsync<{ group_id: string | null }>('SELECT group_id FROM sharing_current_workspace WHERE user_id=?', selection.userId);
  if (current?.group_id !== selection.groupId) return;
  const record = await readSharingWorkspace(db, selection.userId, selection.groupId); if (!record || record.status !== 'active') return;
  const model = await startupDisplayCache.read(record); if (!model) return;
  // Login/logout clear the protected selection before changing Firebase users.
  const latest = await readSharingSelection();
  if (latest?.userId === selection.userId && latest.groupId === selection.groupId) return { record, model };
}
