import { exactRecord, positiveInteger } from '../private-calendar/validation.ts';
import { canonicalJson } from '../operations.ts';
import { privatePreferenceCursor, samePrivatePreferenceCursor, snapshotEncryptedPrivatePreferences, snapshotPrivatePreferenceCursor } from './preference-crypto.ts';
import type { EncryptedPrivatePreferences, PrivatePreferenceCursor } from './preference-crypto.ts';
import { snapshotPrivatePlannerPreferences, snapshotSavedPrivatePlannerPreferences, privatePlannerPreferenceValues } from './preferences.ts';
import type { PrivatePlannerPreferences, SavedPrivatePlannerPreferences } from './preferences.ts';

export interface AcceptedPrivatePreferences { cursor: PrivatePreferenceCursor; preferences: PrivatePlannerPreferences }
export interface PrivatePreferenceSyncState {
  schemaVersion: 2; ownerUserId: string; local: SavedPrivatePlannerPreferences | null;
  baseline: AcceptedPrivatePreferences | null; review: AcceptedPrivatePreferences | null;
  pending: { localRevision: number; encrypted: EncryptedPrivatePreferences } | null;
  retry: { localRevision: number; digest: string | null; count: number; attemptedAt: number; nextAt: number } | null;
}
export const preferenceValues = privatePlannerPreferenceValues;
export const samePreferenceValues = (a: PrivatePlannerPreferences | null, b: PrivatePlannerPreferences | null) =>
  a === null ? b === null : b !== null && canonicalJson(preferenceValues(a)) === canonicalJson(preferenceValues(b));
export function emptyPrivatePreferenceSyncState(ownerUserId: string): PrivatePreferenceSyncState {
  return { schemaVersion: 2, ownerUserId, local: null, baseline: null, review: null, pending: null, retry: null };
}
function accepted(value: AcceptedPrivatePreferences): AcceptedPrivatePreferences {
  exactRecord(value, ['cursor', 'preferences']); return { cursor: snapshotPrivatePreferenceCursor(value.cursor), preferences: snapshotPrivatePlannerPreferences(value.preferences) };
}
export function snapshotPrivatePreferenceSyncState(value: PrivatePreferenceSyncState, ownerUserId: string): PrivatePreferenceSyncState {
  exactRecord(value, ['schemaVersion', 'ownerUserId', 'local', 'baseline', 'review', 'pending', 'retry']);
  if (value.schemaVersion !== 2 || value.ownerUserId !== ownerUserId) throw new Error('本人設定の保存先を確認してください。');
  const local = value.local === null ? null : snapshotSavedPrivatePlannerPreferences(value.local, ownerUserId);
  const baseline = value.baseline === null ? null : accepted(value.baseline); const review = value.review === null ? null : accepted(value.review);
  let pending: PrivatePreferenceSyncState['pending'] = null;
  if (value.pending !== null) {
    exactRecord(value.pending, ['localRevision', 'encrypted']); positiveInteger(value.pending.localRevision);
    const encrypted = snapshotEncryptedPrivatePreferences(value.pending.encrypted);
    if (!local || encrypted.body.ownerUserId !== ownerUserId || value.pending.localRevision > local.revision
      || !samePrivatePreferenceCursor(encrypted.body.parent, baseline?.cursor ?? null)) throw new Error('保存済みの本人設定と送信待ちの内容が一致しません。');
    pending = { localRevision: value.pending.localRevision, encrypted };
  }
  if (!local && (baseline || review || pending) || review && (baseline && review.cursor.revision <= baseline.cursor.revision)) throw new Error('本人設定の確認位置が異なります。');
  let retry: PrivatePreferenceSyncState['retry'] = null;
  if (value.retry !== null) {
    exactRecord(value.retry, ['localRevision', 'digest', 'count', 'attemptedAt', 'nextAt']); positiveInteger(value.retry.count);
    if (!local || value.retry.localRevision !== local.revision || value.retry.count > 32 || !Number.isSafeInteger(value.retry.nextAt)
      || !Number.isSafeInteger(value.retry.attemptedAt) || value.retry.attemptedAt < 0 || value.retry.nextAt <= value.retry.attemptedAt || value.retry.nextAt - value.retry.attemptedAt > 4320_000
      || value.retry.digest !== (pending ? privatePreferenceCursor(pending.encrypted).digest : null)) throw new Error('本人設定の再送位置を確認してください。');
    retry = { ...value.retry };
  }
  return { schemaVersion: 2, ownerUserId, local, baseline, review, pending, retry };
}
function withLocal(state: PrivatePreferenceSyncState, preferences: PrivatePlannerPreferences): PrivatePreferenceSyncState {
  if (samePreferenceValues(state.local, preferences)) return state;
  const revision = (state.local?.revision ?? 0) + 1; positiveInteger(revision);
  return { ...state, local: { schemaVersion: 1, ownerUserId: state.ownerUserId, revision, ...preferenceValues(preferences) } };
}
/** A remote snapshot cannot silently select a winner between independent local edits. */
export function observePrivatePreferences(state: PrivatePreferenceSyncState, remote: AcceptedPrivatePreferences | null): PrivatePreferenceSyncState {
  if (!remote) { if (state.baseline || state.review) throw new Error('本人設定のサーバー保存位置が失われています。再作成せず確認してください。'); return state; }
  remote = accepted(remote); const prior = state.review ?? state.baseline;
  if (prior && (remote.cursor.revision < prior.cursor.revision || remote.cursor.revision === prior.cursor.revision && remote.cursor.digest !== prior.cursor.digest)) throw new Error('本人設定の古い内容または分岐した内容を検出しました。');
  if (prior && samePrivatePreferenceCursor(remote.cursor, prior.cursor) && !samePreferenceValues(remote.preferences, prior.preferences)) throw new Error('同じ本人設定の確認位置に別の内容があります。');
  if (samePrivatePreferenceCursor(remote.cursor, state.baseline?.cursor ?? null)) return state.retry && !state.pending && samePreferenceValues(state.local, state.baseline?.preferences ?? null)
    ? { ...state, retry: null } : state;
  const pendingAccepted = state.pending && samePrivatePreferenceCursor(privatePreferenceCursor(state.pending.encrypted), remote.cursor);
  if (!state.local || samePreferenceValues(state.local, remote.preferences) || pendingAccepted) {
    // A later local edit made while the exact envelope was in flight remains dirty against the accepted baseline.
    const next = state.local ? state : withLocal(state, remote.preferences);
    return { ...next, baseline: remote, review: null, pending: null, retry: null };
  }
  if (!state.review && samePreferenceValues(state.local, state.baseline?.preferences ?? null) && !state.pending) {
    return { ...withLocal(state, remote.preferences), baseline: remote, review: null, pending: null, retry: null };
  }
  return { ...state, review: remote };
}
export function resolvePrivatePreferenceReview(state: PrivatePreferenceSyncState, expectedRevision: number, expectedRemote: PrivatePreferenceCursor,
  choice: 'local' | 'remote'): PrivatePreferenceSyncState {
  if (!state.local || state.local.revision !== expectedRevision || !state.review || !samePrivatePreferenceCursor(state.review.cursor, snapshotPrivatePreferenceCursor(expectedRemote))
    || !['local', 'remote'].includes(choice)) throw new Error('本人設定の競合内容が更新されています。再読込して確認してください。');
  const next = choice === 'remote' ? withLocal(state, state.review.preferences) : state;
  return { ...next, baseline: state.review, review: null, pending: null, retry: null };
}
