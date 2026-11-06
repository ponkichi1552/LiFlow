import type { CalendarQueryRange } from '../../google-sync/calendar-availability.ts';
import { createCalendarQueryRange } from '../../google-sync/calendar-availability.ts';
import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarSourceStorage } from '../../../platform/storage/private-calendar-source.ts';
import type { createPrivateCalendarCacheStorage } from '../../../platform/storage/private-calendar-cache.ts';
import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import type { PrivateCalendarCryptoGateway } from './crypto-gateway.ts';
import type { EncryptedPrivateCalendarCache } from './cache-crypto.ts';
import { sealPrivateCalendarCache } from './cache-crypto.ts';
import { assertPrivateCalendarCloudAuthority } from './cloud-contract.ts';
import { privateCalendarSourceBinding } from './source-controller.ts';
import { privateCalendarDeliveryFailureCode } from './delivery-retry.ts';
import { exactRecord } from './validation.ts';
import { instantMilliseconds } from '../v2/date-target.ts';
import { mergeInstantRanges } from '../v2/private-availability.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { assertPrivateCalendarDeadline, privateCalendarDeadlineError, privateCalendarWork } from './sync-deadline.ts';

export interface PrivateCalendarCapturePort {
  userId: string; assertOwner(): void | Promise<void>;
  secrets: ReturnType<typeof createPrivateCalendarSecretStore>; source: ReturnType<typeof createPrivateCalendarSourceStorage>;
  cache: ReturnType<typeof createPrivateCalendarCacheStorage>; crypto: PrivateCalendarCryptoGateway;
  cloud: Pick<ReturnType<typeof createPrivateCalendarCloud>, 'readHead' | 'uploadCache'>;
  /** Noninteractive, bound to this explicit Google subject before and after acquisition. No Firebase-UID inference. */
  queryGoogle(subject: string, range: CalendarQueryRange, options?: { deadline?: number; assertBudget?: () => void; signal?: AbortSignal }): Promise<readonly { start: string; end: string }[]>;
  now?: () => number; randomFraction?: () => number;
}
function rangeSnapshot(range: CalendarQueryRange): CalendarQueryRange {
  exactRecord(range, ['from', 'through', 'timeMin', 'timeMax', 'timeZone']); const owned = { ...range };
  const expected = createCalendarQueryRange(owned.from, owned.through, owned.timeZone);
  if (owned.timeMin !== expected.timeMin || owned.timeMax !== expected.timeMax
    || Date.parse(owned.timeMax) - Date.parse(owned.timeMin) > 367 * 86400000) throw new Error('本人用Calendarの取得範囲を確認してください。');
  return owned;
}
export function snapshotPrivateCalendarIntervals(raw: readonly { start: string; end: string }[], range: CalendarQueryRange) {
  if (!Array.isArray(raw) || raw.length > 100_000) throw new Error('Calendarから返された区間の件数が上限を超えています。');
  const min = Date.parse(range.timeMin); const max = Date.parse(range.timeMax);
  const intervals = mergeInstantRanges(raw.map(part => {
    exactRecord(part, ['start', 'end']);
    if (typeof part.start !== 'string' || typeof part.end !== 'string') throw new Error('Calendarから返された時間帯が無効です。');
    const start = instantMilliseconds(part.start); const end = instantMilliseconds(part.end);
    if (start >= end) throw new Error('Calendarから返された時間帯が無効です。');
    return { start: Math.max(min, start), end: Math.min(max, end) };
  }).filter(part => part.start < part.end));
  if (intervals.length > 20_000) throw new Error('本人用Calendarの時間帯の件数が上限を超えています。');
  return intervals.map(part => ({ start: new Date(part.start).toISOString(), end: new Date(part.end).toISOString() }));
}

/** One bounded acquisition/publication action. Scheduling, permissions and retry UI belong to its caller. */
export function createPrivateCalendarCapture(port: PrivateCalendarCapturePort) {
  const { userId, secrets, source, cache, cloud, crypto, now = Date.now, randomFraction = Math.random } = port; assertSharedIdentifier(userId);
  async function run(range: CalendarQueryRange, force: boolean, automatic: boolean, deadline?: number, assertBudget?: () => void, signal?: AbortSignal) {
    const withinBudget = () => { if (signal?.aborted) throw privateCalendarDeadlineError(); assertBudget?.(); assertPrivateCalendarDeadline(deadline, now()); }; withinBudget();
    await port.assertOwner(); const state = await secrets.publicState(userId); const authority = state?.authority; withinBudget();
    if (!authority) return { kind: 'unconfigured' as const };
    if (!authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId)) return { kind: 'revoked' as const };
    if (authority.signed.body.mainDeviceId !== state.identity.deviceId) return { kind: 'notMain' as const };
    const profile = await source.read();
    if (profile?.pending) return { kind: 'sourcePending' as const };
    const subject = profile?.active?.googleSubject; if (!subject) return { kind: 'disabled' as const };
    if (!state.hasCurrentKey) return { kind: 'awaitingKey' as const };
    const binding = privateCalendarSourceBinding(authority); const start = now();
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isFinite(new Date(start).getTime())) throw new Error('Calendarの取得時刻を確認してください。');
    instantMilliseconds(new Date(start).toISOString());
    async function assertContext() {
      withinBudget();
      await port.assertOwner(); const current = await secrets.publicState(userId); const selected = await source.read(); await port.assertOwner();
      withinBudget();
      if (current?.authority?.digest !== authority!.digest || current.identity.deviceId !== state!.identity.deviceId
        || !current.hasCurrentKey || selected?.pending || selected?.active?.googleSubject !== subject) throw new Error('本人用Calendarの取得中に端末・取得元が変わりました。');
    }
    async function head() { await assertContext(); const current = await privateCalendarWork(() => cloud.readHead(withinBudget), { assertBudget: withinBudget, signal }); if (!current) throw new Error('本人用Calendarのサーバー設定がありません。'); assertPrivateCalendarCloudAuthority(current, authority!); return current; }
    async function publish(encrypted: EncryptedPrivateCalendarCache) {
      const digest = sharedDocumentDigest(encrypted.manifest); await head();
      try { await privateCalendarWork(() => cloud.uploadCache(authority!, encrypted, withinBudget), { assertBudget: withinBudget, signal }); }
      catch (error) {
        await cache.fail(authority!, digest, now(), privateCalendarDeliveryFailureCode(error), randomFraction()); throw error;
      }
      await assertContext();
      if (!await cache.acknowledge(authority!, digest)) {
        const confirmed = await cache.status(authority!);
        if (!confirmed?.authorityCurrent || confirmed.cursor.manifestDigest !== digest || confirmed.pending) throw new Error('本人用Calendarの受付確認中に保存内容が変わりました。');
      }
      await assertContext(); return { kind: 'published' as const, sequence: encrypted.manifest.body.sequence };
    }
    const status = await cache.status(authority);
    if (status?.authorityCurrent && status.pending) {
      const pending = await cache.pending(authority, start, { force });
      if (!pending) return { kind: 'waiting' as const, retryAt: status.retryAt };
      const key = await secrets.currentKey(userId, authority);
      try { if (!key || !await cache.read({ authority, accountKey: key, calendarBinding: binding })) throw new Error('送信待ちの取得元を確認できません。'); }
      finally { key?.fill(0); }
      return publish(pending.encrypted);
    }
    const acquisition = await cache.beginAcquisition(authority, { rangeDigest: sharedDocumentDigest(range), now: start, force, automatic, randomFraction: randomFraction() });
    if (acquisition.kind !== 'acquired') return acquisition;
    try {
      await head();
      withinBudget(); const raw = await port.queryGoogle(subject, { ...range }, { deadline, assertBudget: withinBudget, signal }); withinBudget();
      const intervals = snapshotPrivateCalendarIntervals(raw, range);
      const acceptedHead = await head(); const local = await cache.status(authority);
      const sequence = Math.max(local?.cursor.sequence ?? 0, acceptedHead.cacheHead?.sequence ?? 0) + 1;
      let key = await secrets.currentKey(userId, authority);
      try {
        if (!key) throw new Error('本人用Calendarの鍵の受信を確認してください。');
        const body = { ownerUserId: userId, accountGeneration: authority.anchor.accountGeneration, mainDeviceId: state.identity.deviceId,
          mainRevision: authority.signed.body.revision, calendarBinding: binding, timeZone: range.timeZone, fetchedAt: new Date(start).toISOString(),
          coverage: { start: range.timeMin, end: range.timeMax }, intervals };
        const encrypted = await sealPrivateCalendarCache(crypto, { authority, accountKey: key, calendarBinding: binding, cache: body, mainDevice: await secrets.identity(userId), sequence });
        await assertContext(); await cache.save(encrypted, { authority, accountKey: key, calendarBinding: binding, origin: 'local',
          acquisition: { lease: acquisition.lease, now: () => { withinBudget(); return now(); } } });
        return await publish(encrypted);
      } finally { key?.fill(0); key = null; }
    } catch (error) {
      // A changed owner/authority or a newer query must not be modified by the failed old attempt.
      await cache.failAcquisition(authority, acquisition.lease, now(), privateCalendarDeliveryFailureCode(error), randomFraction()).catch(() => undefined);
      throw error;
    }
  }
  let flight: { scope: string; force: boolean; promise: ReturnType<typeof run> } | null = null;
  function capture(options: { range: CalendarQueryRange; force?: boolean; automatic?: boolean; deadline?: number; assertBudget?: () => void; signal?: AbortSignal }): ReturnType<typeof run> {
    const range = rangeSnapshot(options.range); const force = options.force === true; const scope = canonicalJson(range);
    const { deadline, assertBudget, signal } = options;
    if (flight) {
      const current = flight;
      if (current.scope !== scope) return Promise.reject(new Error('別の範囲のCalendarを更新中です。完了後に再試行してください。'));
      return force && !current.force ? current.promise.then(result => result.kind === 'waiting' || result.kind === 'fresh' ? capture({ range, force, deadline, assertBudget, signal }) : result) : current.promise;
    }
    const pending = run(range, force, options.automatic === true, deadline, assertBudget, signal); flight = { scope, force, promise: pending };
    void pending.finally(() => { if (flight?.promise === pending) flight = null; }).catch(() => {}); return pending;
  }
  return { capture };
}
