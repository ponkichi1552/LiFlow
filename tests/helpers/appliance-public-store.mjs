import { createFirestoreUsageStore } from '../../server/appliance-care-api/src/firestore-usage-store.mjs';
import { Buffer } from 'node:buffer';

/** Public synthetic material, never used by a runtime or a deployment. */
export const syntheticAnalysisQueueKeys = () => ({ activeKeyId: 'synthetic-queue-key', keys: new Map([['synthetic-queue-key', Buffer.alloc(32, 43)]]) });

/** Unit double for atomic commits/rollback. The same store also runs against the real Firestore emulator. */
export function publicStoreFixture(options = {}) {
  const analysisQueueKeys = options.analysisQueueKeys ?? syntheticAnalysisQueueKeys();
  const records = new Map(); let queued = Promise.resolve(); let fail = false; let committedWrites = 0;
  function snapshot(path, selected) {
    const original = records.get(path);
    const value = original && selected ? Object.fromEntries(selected.map(key => [key, original[key]]).filter(([, value]) => value !== undefined)) : original;
    return { id: path.split('/').at(-1), ref: ref(path), exists: value !== undefined, data() {
      const copy = structuredClone(value);
      if (copy?.expiresAt instanceof Date) copy.expiresAt = { toMillis: () => value.expiresAt.getTime() };
      return copy;
    } };
  }
  function ref(path) { return { path, collection: collection => query(`${path}/${collection}`), get: async () => snapshot(path) }; }
  function query(collection, filters = [], sorting = [], maximum = Infinity, selected) {
    return { doc: name => ref(`${collection}/${name}`),
      where: (field, operator, value) => query(collection, [...filters, [field, operator, value]], sorting, maximum, selected),
      orderBy: field => query(collection, filters, [...sorting, field], maximum, selected),
      limit: value => query(collection, filters, sorting, value, selected),
      select: (...fields) => query(collection, filters, sorting, maximum, fields),
      async get() {
        let rows = [...records.entries()].filter(([path]) => path.startsWith(`${collection}/`) && path.split('/').length === collection.split('/').length + 1);
        rows = rows.filter(([, record]) => filters.every(([field, operator, value]) => {
          if (operator === '<=') return record[field] <= value;
          if (operator === '==') return record[field] === value;
          throw new Error('Unsupported fixture query');
        }));
        rows.sort((a, b) => { for (const field of sorting) { const diff = a[1][field] - b[1][field]; if (diff) return diff; } return a[0].localeCompare(b[0]); });
        return { docs: rows.slice(0, maximum).map(([path]) => snapshot(path, selected)) };
      } };
  }
  const firestore = { collection: name => query(name),
    getAll: async (...targets) => targets.map(target => snapshot(target.path)),
    runTransaction(callback) {
      const pending = queued.then(async () => {
        if (fail) throw new Error('synthetic storage unavailable');
        const writes = [];
        const result = await callback({ get: async target => snapshot(target.path), getAll: async (...targets) => targets.map(target => snapshot(target.path)),
          set: (target, data) => writes.push([target.path, data]), create(target, data) {
            if (records.has(target.path)) throw new Error('already exists'); writes.push([target.path, data]);
          }, update: (target, data) => writes.push([target.path, { ...records.get(target.path), ...data }]),
          delete: target => writes.push([target.path, undefined]) });
        for (const [path, data] of writes) { if (data === undefined) records.delete(path); else records.set(path, structuredClone(data)); }
        committedWrites += writes.length;
        return result;
      }); queued = pending.catch(() => undefined); return pending;
    } };
  return { records, firestore, analysisQueueKeys, writes: () => committedWrites, store: createFirestoreUsageStore({ firestore, analysisQueueKeys, ...options }), fail: value => { fail = value; } };
}
