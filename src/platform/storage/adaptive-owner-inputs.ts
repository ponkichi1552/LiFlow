import type { SQLiteDatabase } from 'expo-sqlite';
import type { SavedPrivatePlannerPreferences } from '../../features/sharing/private-planner/preferences';
import type { V2CommonPlan } from '../../features/sharing/v2/common-plan';
import type { LocalDate } from '../../domain/shared/types';
import type { CapturedSharedPlanning } from '../../features/planner/shared-adaptive-load';
import type { SharedCalendarRecord } from '../../features/sharing/v2/calendar-state';
import type { PrivateBusyPlacementInput } from '../../features/planner/private-busy-input';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';

export interface AdaptiveOwnerInputs {
  ownerUserId: string | null;
  preferences: SavedPrivatePlannerPreferences | null;
  common: V2CommonPlan | null;
  sharedPlanning?: CapturedSharedPlanning;
  sharedCalendar?: readonly SharedCalendarRecord[];
  privateCalendar?: PrivateBusyPlacementInput;
  /** Synchronous account/settings-generation guard also protects optimistic display caches. */
  assertCurrent(): void;
  /** Protected revision and independent-connection checks, once at transaction publication. */
  assertCommitCurrent?(): Promise<void>;
}
export type AdaptiveOwnerReader = (now: Date, database: SQLiteDatabase) => Promise<AdaptiveOwnerInputs | null>;
export class AdaptiveOwnerInputsChangedError extends Error {
  constructor() { super('本人の予定設定が更新されました。最新の設定で再計算します。'); }
}
let nativeReader: AdaptiveOwnerReader | undefined;
const readers = new WeakMap<SQLiteDatabase, AdaptiveOwnerReader>();
const scopes = new WeakMap<SQLiteDatabase, { read(now: Date): Promise<AdaptiveOwnerInputs | null>; peek(): Promise<AdaptiveOwnerInputs | null> | undefined }>();
export function setNativeAdaptiveOwnerReader(reader: AdaptiveOwnerReader) { nativeReader = reader; }
export function adaptiveOwnerReaderIdentity(database: SQLiteDatabase) { return readers.get(database) ?? nativeReader; }
/** A private connection override supplies deterministic offline fixtures and isolated integrations. */
export function bindAdaptiveOwnerReader(database: SQLiteDatabase, reader: AdaptiveOwnerReader) {
  readers.set(database, reader); return () => { if (readers.get(database) === reader) readers.delete(database); };
}
export async function withAdaptiveOwnerInputScope<T>(database: SQLiteDatabase, work: () => Promise<T>): Promise<T> {
  const prior = scopes.get(database); if (prior) return work();
  let pending: Promise<AdaptiveOwnerInputs | null> | undefined;
  scopes.set(database, { read: now => pending ??= (readers.get(database) ?? nativeReader)?.(now, database) ?? Promise.resolve(null), peek: () => pending });
  try { return await work(); } finally { scopes.delete(database); }
}
export async function assertCapturedAdaptiveOwnerInputs(database: SQLiteDatabase) {
  const pending = scopes.get(database)?.peek(); if (!pending) return;
  const value = await pending; value?.assertCurrent(); await value?.assertCommitCurrent?.(); value?.assertCurrent();
}
/** A transaction which used owner inputs must reject drift before COMMIT, including its last write. */
export async function withAdaptiveOwnerTransaction<T>(database: SQLiteDatabase, work: () => Promise<T>): Promise<T> {
  let result!: T;
  await database.withTransactionAsync(async () => { result = await work(); await assertCapturedAdaptiveOwnerInputs(database); });
  return result;
}
export async function inheritAdaptiveOwnerInputScope<T>(parent: SQLiteDatabase, child: SQLiteDatabase, work: () => Promise<T>): Promise<T> {
  if (parent === child || !scopes.has(parent)) return work();
  const prior = scopes.get(child); scopes.set(child, scopes.get(parent)!);
  try { return await work(); } finally { if (prior) scopes.set(child, prior); else scopes.delete(child); }
}
export async function readAdaptiveOwnerInputs(database: SQLiteDatabase, now: Date): Promise<AdaptiveOwnerInputs | null> {
  const value = await (scopes.get(database)?.read(now) ?? (readers.get(database) ?? nativeReader)?.(now, database) ?? null);
  value?.assertCurrent();
  if (value?.preferences && value.preferences.ownerUserId !== value.ownerUserId || value?.common && !value.ownerUserId
    || value?.privateCalendar && value.privateCalendar.ownerUserId !== value.ownerUserId) throw new Error('本人の家事設定を確認してください。');
  return value;
}
export async function adaptiveOwnerClock(database: SQLiteDatabase, now: Date, fallback: { today: LocalDate; timeZone: string }) {
  const owner = await readAdaptiveOwnerInputs(database, now);
  const timeZone = owner?.preferences?.timeZone ?? fallback.timeZone;
  return { owner, timeZone, today: owner?.preferences ? sharedLocalDate(now, timeZone) : fallback.today };
}
