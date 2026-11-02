import { createFirestoreUsageStore } from '../../server/appliance-care-api/src/firestore-usage-store.mjs';

/** Unit double for atomic commits/rollback. The same store also runs against the real Firestore emulator. */
export function publicStoreFixture(options = {}) {
  const records = new Map(); let queued = Promise.resolve(); let fail = false; let committedWrites = 0;
  function snapshot(path) {
    const value = records.get(path);
    return { id: path.split('/').at(-1), exists: value !== undefined, data() {
      const copy = structuredClone(value);
      if (copy?.expiresAt instanceof Date) copy.expiresAt = { toMillis: () => value.expiresAt.getTime() };
      return copy;
    } };
  }
  function ref(path) { return { path, collection: collection => ({ doc: name => ref(`${path}/${collection}/${name}`) }), get: async () => snapshot(path) }; }
  const firestore = { collection: collection => ({ doc: name => ref(`${collection}/${name}`) }),
    getAll: async (...targets) => targets.map(target => snapshot(target.path)),
    runTransaction(callback) {
      const pending = queued.then(async () => {
        if (fail) throw new Error('synthetic storage unavailable');
        const writes = [];
        const result = await callback({ get: async target => snapshot(target.path), getAll: async (...targets) => targets.map(target => snapshot(target.path)),
          set: (target, data) => writes.push([target.path, data]), create(target, data) {
            if (records.has(target.path)) throw new Error('already exists'); writes.push([target.path, data]);
          }, update: (target, data) => writes.push([target.path, { ...records.get(target.path), ...data }]) });
        for (const [path, data] of writes) records.set(path, structuredClone(data));
        committedWrites += writes.length;
        return result;
      }); queued = pending.catch(() => undefined); return pending;
    } };
  return { records, firestore, writes: () => committedWrites, store: createFirestoreUsageStore({ firestore, ...options }), fail: value => { fail = value; } };
}
