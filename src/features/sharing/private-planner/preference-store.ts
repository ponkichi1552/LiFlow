import { assertSharedIdentifier } from '../identifier.ts';
import { snapshotPrivatePlannerPreferences, snapshotSavedPrivatePlannerPreferences } from './preferences.ts';
import type { PrivatePlannerPreferences } from './preferences.ts';
import { canonicalJson } from '../operations.ts';
import { emptyPrivatePreferenceSyncState, observePrivatePreferences, preferenceValues, resolvePrivatePreferenceReview,
  samePreferenceValues, snapshotPrivatePreferenceSyncState } from './preference-sync-state.ts';
import type { AcceptedPrivatePreferences, PrivatePreferenceSyncState } from './preference-sync-state.ts';
import { privatePreferenceCursor, samePrivatePreferenceCursor, snapshotEncryptedPrivatePreferences, snapshotPrivatePreferenceCursor } from './preference-crypto.ts';
import type { EncryptedPrivatePreferences, PrivatePreferenceCursor } from './preference-crypto.ts';
import { snapshotLocalPreferenceProjection } from './local-projection.ts';
import type { LocalPreferenceProjection } from './local-projection';

export interface PrivatePlannerPreferencePort {
  ownerUserId: string;
  vault: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  assertOwner(userId: string): void | Promise<void>;
  exclusive<T>(userId: string, work: () => Promise<T>): Promise<T>;
  afterSave?(): void;
  subscribe?(listener: () => void): () => void;
}
export class PrivatePlannerPreferenceConflict extends Error {
  constructor() { super('本人の設定が別の操作で更新されています。保存済みの内容を再読込して確認してください。'); this.name = 'PrivatePlannerPreferenceConflict'; }
}
/** Local value, accepted baseline and exact pending envelope share one protected publication. */
export function createPrivatePlannerPreferenceStore(port: PrivatePlannerPreferencePort) {
  const { ownerUserId, vault } = port; assertSharedIdentifier(ownerUserId); const key = `private-planner-preferences:${ownerUserId}`;
  const projectionKey = `${key}:local-projection`;
  const readProjectionInside = async () => {
    await port.assertOwner(ownerUserId); const raw = await vault.getItem(projectionKey); await port.assertOwner(ownerUserId);
    if (raw === null || raw === 'null') return null;
    if (raw.length > 16 * 1024) throw new Error('生活リズムの未反映データを確認してください。');
    return snapshotLocalPreferenceProjection(JSON.parse(raw));
  };
  async function saved(): Promise<PrivatePreferenceSyncState> {
    await port.assertOwner(ownerUserId); const raw = await vault.getItem(key); await port.assertOwner(ownerUserId);
    if (raw === null) return emptyPrivatePreferenceSyncState(ownerUserId);
    if (typeof raw !== 'string' || raw.length > 64 * 1024) throw new Error('本人の保存済み設定を確認できません。');
    const value = JSON.parse(raw);
    // Read-only compatibility. A legacy local-only profile is upgraded on the next actual write, never reset on read.
    return value?.schemaVersion === 1 ? { ...emptyPrivatePreferenceSyncState(ownerUserId), local: snapshotSavedPrivatePlannerPreferences(value, ownerUserId) }
      : snapshotPrivatePreferenceSyncState(value, ownerUserId);
  }
  async function readSyncState() {
    await port.assertOwner(ownerUserId); const value = await port.exclusive(ownerUserId, saved); await port.assertOwner(ownerUserId); return value;
  }
  async function change(work: (state: PrivatePreferenceSyncState) => PrivatePreferenceSyncState): Promise<PrivatePreferenceSyncState> {
    await port.assertOwner(ownerUserId); let prepared: PrivatePreferenceSyncState | null = null; let result: PrivatePreferenceSyncState;
    try {
      result = await port.exclusive(ownerUserId, async () => {
        const before = await saved(); const after = snapshotPrivatePreferenceSyncState(work(before), ownerUserId);
        if (canonicalJson(before) === canonicalJson(after)) return before;
        prepared = after; await port.assertOwner(ownerUserId); await vault.setItem(key, JSON.stringify(after)); await port.assertOwner(ownerUserId); return after;
      });
    } catch (error) {
      // A protected publication can outlive its reply or the surrounding SQL lock. Never replay the callback.
      if (!prepared) throw error;
      let recovered;
      try { recovered = await readSyncState(); } catch { throw error; }
      if (canonicalJson(recovered) !== canonicalJson(prepared)) throw error; result = recovered;
    }
    await port.assertOwner(ownerUserId);
    try { if (prepared) port.afterSave?.(); } catch { /* A subscriber cannot roll back protected storage. */ }
    return result;
  }
  return { read: async () => (await readSyncState()).local, readSyncState, subscribe: port.subscribe ?? (() => () => {}),
    readLocalProjection: () => port.exclusive(ownerUserId, readProjectionInside),
    prepareLocalProjection: async (value: LocalPreferenceProjection) => {
      const own = snapshotLocalPreferenceProjection(value);
      const json = JSON.stringify(own);
      if (json.length > 16 * 1024) throw new Error('生活リズムの未反映データが大きすぎます。');
      await port.exclusive(ownerUserId, async () => {
        const state = await saved();
        if ((state.local?.revision ?? 0) !== own.privateRevision && !(state.local?.revision === own.privateRevision + 1 && samePreferenceValues(state.local, own.preferences))) throw new PrivatePlannerPreferenceConflict();
        await port.assertOwner(ownerUserId);
        try { await vault.setItem(projectionKey, json); }
        catch (cause) { if (canonicalJson(await readProjectionInside()) !== canonicalJson(own)) throw cause; }
        await port.assertOwner(ownerUserId);
      });
    },
    clearLocalProjection: async (value: LocalPreferenceProjection) => {
      const own = snapshotLocalPreferenceProjection(value);
      await port.exclusive(ownerUserId, async () => {
        if (canonicalJson(await readProjectionInside()) !== canonicalJson(own)) return;
        await vault.setItem(projectionKey, 'null'); await port.assertOwner(ownerUserId);
      });
    },
    async save(expectedRevision: number, input: PrivatePlannerPreferences) {
      const own = snapshotPrivatePlannerPreferences(input);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('保存する設定の版を確認してください。');
      const result = await change(state => {
        const before = state.local;
        if ((before?.revision ?? 0) !== expectedRevision) {
          if (before && before.revision === expectedRevision + 1 && samePreferenceValues(before, own)) return state;
          throw new PrivatePlannerPreferenceConflict();
        }
        return before && samePreferenceValues(before, own) ? state : { ...state, retry: null,
          local: { schemaVersion: 1, ownerUserId, revision: expectedRevision + 1, ...own } };
      });
      return result.local!;
    },
    async prepareUpload(expectedRevision: number, expectedBase: PrivatePreferenceCursor | null, encrypted: EncryptedPrivatePreferences) {
      const own = snapshotEncryptedPrivatePreferences(encrypted); const base = expectedBase === null ? null : snapshotPrivatePreferenceCursor(expectedBase);
      return change(state => {
        if (!state.local || state.local.revision !== expectedRevision || state.review || !samePrivatePreferenceCursor(state.baseline?.cursor ?? null, base)
          || !samePrivatePreferenceCursor(own.body.parent, base) || own.body.ownerUserId !== ownerUserId) throw new PrivatePlannerPreferenceConflict();
        if (state.pending?.localRevision === expectedRevision && state.pending.encrypted.body.authorityDigest === own.body.authorityDigest) return state;
        return { ...state, pending: { localRevision: expectedRevision, encrypted: own }, retry: null };
      });
    },
    recordDeliveryFailure: (expectedRevision: number, digest: string | null, now: number, randomFraction: number) => change(state => {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(randomFraction) || randomFraction < 0 || randomFraction > 1) throw new Error('本人設定の再送時刻を確認してください。');
      if (!state.local || state.local.revision !== expectedRevision || (state.pending ? privatePreferenceCursor(state.pending.encrypted).digest : null) !== digest) return state;
      const count = Math.min(32, (state.retry?.count ?? 0) + 1); const wait = Math.min(3600_000, 30_000 * 2 ** Math.min(count - 1, 7));
      return { ...state, retry: { localRevision: expectedRevision, digest, count, attemptedAt: now, nextAt: now + Math.round(wait * (0.8 + randomFraction * 0.4)) } };
    }),
    observeRemote: (remote: AcceptedPrivatePreferences | null) => {
      const own = remote === null ? null : { cursor: snapshotPrivatePreferenceCursor(remote.cursor), preferences: preferenceValues(remote.preferences) };
      return change(state => observePrivatePreferences(state, own));
    },
    resolveReview: (expectedRevision: number, expectedRemote: PrivatePreferenceCursor, choice: 'local' | 'remote') => {
      const cursor = snapshotPrivatePreferenceCursor(expectedRemote);
      return change(state => resolvePrivatePreferenceReview(state, expectedRevision, cursor, choice));
    },
  };
}
export type PrivatePlannerPreferenceStore = ReturnType<typeof createPrivatePlannerPreferenceStore>;
