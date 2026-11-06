import type { SQLiteDatabase } from 'expo-sqlite';

const listeners = new WeakMap<SQLiteDatabase, Set<() => void>>();
export function subscribeToGoogleAccountChanges(database: SQLiteDatabase, listener: () => void) {
  let set = listeners.get(database); if (!set) { set = new Set(); listeners.set(database, set); }
  set.add(listener); return () => { set.delete(listener); };
}
export function notifyGoogleAccountChanged(database: SQLiteDatabase) {
  for (const listener of listeners.get(database) ?? []) {
    try { listener(); } catch { /* A display failure must not undo a committed account change. */ }
  }
}
