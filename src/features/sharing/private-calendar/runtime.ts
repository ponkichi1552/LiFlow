import type { PrivateCalendarCapturePort } from './calendar-capture.ts';
import { createPrivateCalendarCapture } from './calendar-capture.ts';
import type { PrivateCalendarDeviceSession } from './device-session.ts';
import type { createPrivateCalendarSourceController } from './source-controller.ts';
import { privateCalendarSourceBinding } from './source-controller.ts';
import type { PrivateBusyCache, PrivateBusyBinding } from '../v2/private-availability.ts';
import { createPrivateCalendarReader } from '../v2/private-availability.ts';
import type { DateTarget } from '../v2/model.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import { createCalendarQueryRange } from '../../google-sync/calendar-availability.ts';
import { assertPrivateCalendarCloudAuthority } from './cloud-contract.ts';
import { assertPrivateCalendarDeadline, privateCalendarDeadline, privateCalendarDeadlineError, withinPrivateCalendarDeadline,
  PRIVATE_CALENDAR_AUTOMATIC_BUDGET_MS, PRIVATE_CALENDAR_MANUAL_BUDGET_MS, privateCalendarWork } from './sync-deadline.ts';
import { observePrivateCalendarForeground } from './foreground-observer.ts';
import type { PrivatePlannerPreferenceStore } from '../private-planner/preference-store.ts';
import type { PrivatePreferenceSync } from '../private-planner/preference-sync.ts';

export interface PrivateCalendarRuntimePort extends PrivateCalendarCapturePort {
  devices: PrivateCalendarDeviceSession; sourceController: ReturnType<typeof createPrivateCalendarSourceController>;
  cloud: PrivateCalendarCapturePort['cloud'] & { readCache: (authority: NonNullable<Awaited<ReturnType<PrivateCalendarCapturePort['secrets']['authority']>>>, checkBudget?: () => void) => Promise<import('./cache-crypto').EncryptedPrivateCalendarCache | null>;
    watch?: (changed: () => void, failed: () => void) => () => void };
  timeZone(): string;
  currentGoogleAccount(): Promise<{ subject: string; label: string } | null>;
  restoreGoogleAccount?: () => Promise<{ subject: string; label: string }>;
  authorizeGoogleSource(expectedSubject: string): Promise<void>;
  plannerPreferences?: Pick<PrivatePlannerPreferenceStore, 'read'>;
  plannerSync?: PrivatePreferenceSync;
}
export function createPrivateCalendarRuntime(port: PrivateCalendarRuntimePort) {
  const { userId, devices, secrets, source, cache, cloud, sourceController, now = Date.now } = port;
  const capture = createPrivateCalendarCapture(port); const listeners = new Set<() => void>();
  let memo: { id: string; promise: Promise<PrivateBusyCache | null> } | null = null;
  let requiresSourceReview = false;
  let stopDeviceChanges: (() => void) | null = null;
  function invalidate() { memo = null; for (const listener of listeners) try { listener(); } catch { /* A view cannot invalidate a committed setting. */ } }
  function subscribe(listener: () => void) {
    listeners.add(listener); stopDeviceChanges ??= devices.subscribe(invalidate);
    return () => { listeners.delete(listener); if (!listeners.size) { stopDeviceChanges?.(); stopDeviceChanges = null; } };
  }
  async function readSettings() {
    await port.assertOwner(); const device = await devices.read();
    const profile = device.authorityDigest ? await source.read() : null; await port.assertOwner();
    return { ownerUserId: userId, device, connected: Boolean(profile?.active?.googleSubject) && !requiresSourceReview, requiresSourceReview, pendingTargetDigest: profile?.pending?.digest ?? null,
      cacheSaved: device.cache?.authorityCurrent === true };
  }
  async function assertMain(expected?: string) {
    await port.assertOwner(); const state = await secrets.publicState(userId); const authority = state?.authority;
    if (!authority || authority.signed.body.mainDeviceId !== state.identity.deviceId || expected && authority.digest !== expected) throw new Error('表示したメイン端末の設定を確認してください。');
    await port.assertOwner(); return authority;
  }
  let action: Promise<unknown> | null = null;
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    if (action) return Promise.reject(new Error('本人用Calendarの操作が終わってから再試行してください。'));
    invalidate(); const pending = (async () => { await port.assertOwner(); const value = await work(); await port.assertOwner(); return value; })(); action = pending;
    void pending.finally(() => { if (action === pending) action = null; invalidate(); }).catch(() => {}); return pending;
  }
  async function readForPlan(): Promise<{ ownerUserId: string; cache: PrivateBusyCache; binding: PrivateBusyBinding } | null> {
    await port.assertOwner(); const state = await secrets.publicState(userId); const authority = state?.authority;
    if (!authority || !authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId) || !state.hasCurrentKey) return null;
    const selected = await source.read();
    if (selected?.pending || authority.signed.body.mainDeviceId === state.identity.deviceId && (!selected?.active?.googleSubject || requiresSourceReview)) return null;
    const status = await cache.status(authority); if (!status?.authorityCurrent) return null;
    const calendarBinding = privateCalendarSourceBinding(authority); const id = `${authority.digest}:${status.cursor.manifestDigest}`;
    let current = memo;
    if (!current || current.id !== id) {
      const promise = (async () => {
        const key = await secrets.currentKey(userId, authority);
        try {
          const body = key ? await cache.read({ authority, accountKey: key, calendarBinding }) : null;
          if (body) { for (const part of body.intervals) Object.freeze(part); Object.freeze(body.intervals); Object.freeze(body.coverage); Object.freeze(body); }
          return body;
        }
        finally { key?.fill(0); }
      })(); current = { id, promise }; memo = current;
    }
    try {
      const body = await current.promise; const after = await secrets.publicState(userId); const profile = await source.read(); const latest = await cache.status(authority); await port.assertOwner();
      if (!body || memo !== current || after?.authority?.digest !== authority.digest || profile?.pending || !latest?.authorityCurrent || latest.cursor.manifestDigest !== status.cursor.manifestDigest
        || authority.signed.body.mainDeviceId === state.identity.deviceId && profile?.active?.googleSubject !== selected?.active?.googleSubject) return null;
      return { ownerUserId: userId, cache: body, binding: { ownerUserId: userId, accountGeneration: authority.anchor.accountGeneration,
        mainDeviceId: authority.signed.body.mainDeviceId, mainRevision: authority.signed.body.revision, calendarBinding } };
    } catch { if (memo === current) memo = null; await port.assertOwner(); return null; }
  }
  type RefreshResult = Awaited<ReturnType<typeof update>> | { kind: 'busy' };
  let refresh: { force: boolean; promise: Promise<RefreshResult>; operation: Promise<RefreshResult>; cancel(): void } | null = null;
  function configure<T>(work: () => Promise<T>): Promise<T> {
    const current = refresh;
    if (current && !current.force) {
      current.cancel(); return current.operation.catch(() => undefined).then(() => mutate(work));
    }
    return mutate(work);
  }
  function requestRefresh(force: boolean, budgetMs: number): Promise<RefreshResult> {
    const deadline = privateCalendarDeadline(now(), budgetMs);
    if (refresh) {
      const current = refresh;
      return force && !current.force ? current.promise.then(result => result.kind === 'waiting' || result.kind === 'fresh' || result.kind === 'unchanged'
        ? requestRefresh(true, budgetMs) : result) : current.promise;
    }
    if (!force && action) return Promise.resolve({ kind: 'busy' as const });
    let expired = false; const controller = new AbortController();
    const cancel = () => { expired = true; controller.abort(); };
    const ensure = () => { if (expired) throw privateCalendarDeadlineError(); assertPrivateCalendarDeadline(deadline, now()); };
    const operation = mutate(() => update(force, deadline, ensure, controller.signal)); const pending = withinPrivateCalendarDeadline(operation, budgetMs, cancel);
    refresh = { force, promise: pending, operation, cancel };
    void operation.finally(() => { if (refresh?.promise === pending) refresh = null; }).catch(() => {}); return pending;
  }
  const refreshData = () => requestRefresh(true, PRIVATE_CALENDAR_MANUAL_BUDGET_MS);
  const synchronizeAutomatically = (options: { budgetMs?: number } = {}) => requestRefresh(false, options.budgetMs ?? PRIVATE_CALENDAR_AUTOMATIC_BUDGET_MS);
  async function update(force: boolean, deadline: number, ensure: () => void, signal: AbortSignal) {
    ensure();
    const device = await devices.synchronizeDevices({ force, assertBudget: ensure, signal }); ensure();
    if (device.phase !== 'approved') return { kind: 'unavailable' as const };
    const planner = port.plannerSync?.synchronize(force, ensure).catch(() => undefined);
    try { return await updateCalendar(force, deadline, ensure, signal); }
    finally { await planner; }
  }
  async function updateCalendar(force: boolean, deadline: number, ensure: () => void, signal: AbortSignal) {
    if ((await source.read())?.pending) {
      const resumed = await sourceController.resume({ assertBudget: ensure, signal }); if (resumed.kind === 'review') return resumed;
      ensure();
    }
    const state = await secrets.publicState(userId); const authority = state?.authority;
    ensure();
    if (!authority || !authority.signed.body.devices.some(value => value.deviceId === state.identity.deviceId)) return { kind: 'unavailable' as const };
    if (authority.signed.body.mainDeviceId === state.identity.deviceId) {
      const profile = await source.read();
      if (profile?.active && !await sourceController.isCurrentSelection({ assertBudget: ensure, signal })) { requiresSourceReview = true; return { kind: 'sourceReview' as const }; }
      ensure();
      requiresSourceReview = false;
      const zone = port.timeZone(); const today = sharedLocalDate(new Date(now()), zone);
      return capture.capture({ range: createCalendarQueryRange(today, addDays(today, 180), zone), force, automatic: !force, deadline, assertBudget: ensure, signal });
    }
    const head = await privateCalendarWork(() => cloud.readHead(ensure), { assertBudget: ensure, signal }); ensure();
    if (!head) throw new Error('本人用Calendarのサーバー設定がありません。'); assertPrivateCalendarCloudAuthority(head, authority);
    if (!head.cacheHead || head.cacheHead.authorityDigest !== authority.digest) return { kind: 'missing' as const };
    const local = await cache.status(authority); ensure();
    if (!force && local?.authorityCurrent && !local.pending && local.cursor.manifestDigest === head.cacheHead.manifestDigest) return { kind: 'unchanged' as const };
    const key = await secrets.currentKey(userId, authority);
    try {
      ensure();
      if (!key) return { kind: 'awaitingKey' as const };
      const encrypted = await privateCalendarWork(() => cloud.readCache(authority, ensure), { assertBudget: ensure, signal }); if (!encrypted) return { kind: 'missing' as const };
      ensure();
      await cache.save(encrypted, { authority, accountKey: key, calendarBinding: privateCalendarSourceBinding(authority), origin: 'remote' }); await port.assertOwner();
      return { kind: 'received' as const, sequence: encrypted.manifest.body.sequence };
    } finally { key?.fill(0); }
  }
  return { readSettings, readForPlan, refreshData, synchronizeAutomatically,
    plannerSync: port.plannerSync,
    syncPlannerPreferences() {
      const deadline = privateCalendarDeadline(now(), PRIVATE_CALENDAR_MANUAL_BUDGET_MS);
      const controller = new AbortController();
      let expired = false; const ensure = () => { if (expired) throw privateCalendarDeadlineError(); assertPrivateCalendarDeadline(deadline, now()); };
      const work = configure(async () => {
        ensure(); const device = await devices.synchronizeDevices({ force: true, assertBudget: ensure, signal: controller.signal }); ensure();
        return device.phase === 'approved' && port.plannerSync ? port.plannerSync.synchronize(true, ensure) : { kind: 'unavailable' as const };
      });
      return withinPrivateCalendarDeadline(work, PRIVATE_CALENDAR_MANUAL_BUDGET_MS, () => { expired = true; controller.abort(); });
    },
    async readPlannerPreferences() {
      await port.assertOwner(); const value = await port.plannerPreferences?.read() ?? null; await port.assertOwner();
      if (value && value.ownerUserId !== userId) throw new Error('本人の予定設定を確認してください。'); return value;
    },
    invalidatePlaintext() { refresh?.cancel(); invalidate(); }, subscribe,
    observeRemote(onReady?: () => void | Promise<void>) {
      const common = { assertOwner: port.assertOwner, subscribeLocal: subscribe, now,
        configured: async () => { const view = await devices.read(); return view.phase === 'approved' || view.phase === 'firstPending'; },
        synchronize: synchronizeAutomatically };
      const calendar = observePrivateCalendarForeground({ ...common, subscribeConfiguration: devices.subscribe,
        watchRemote: (changed, failed) => { if (!cloud.watch) throw new Error('本人用Calendarの変更監視を確認してください。'); return cloud.watch(changed, failed); }, onReady });
      const plannerSync = port.plannerSync;
      // A failed preference listener has its own recovery state and cannot detach the healthy Calendar listener.
      const planner = plannerSync ? observePrivateCalendarForeground({ ...common,
        subscribeConfiguration: listener => { const device = devices.subscribe(listener); const prefs = plannerSync.store.subscribe(listener); return () => { device(); prefs(); }; },
        watchRemote: plannerSync.cloud.watch }) : null;
      return () => { calendar(); planner?.(); };
    },
    async checkGoogleAccount() { await assertMain(); const account = await port.currentGoogleAccount(); await port.assertOwner(); return account; },
    async restoreCurrentGoogleAccount() {
      await assertMain(); if (!port.restoreGoogleAccount) throw new Error('この端末でGoogleログインを確認してください。');
      const account = await port.restoreGoogleAccount(); await port.assertOwner(); return account;
    },
    connectCurrentSource(subject: string, expectedAuthorityDigest: string) {
      return configure(async () => { await assertMain(expectedAuthorityDigest); await port.authorizeGoogleSource(subject); await port.assertOwner();
        const result = await sourceController.change({ googleSubject: subject }, expectedAuthorityDigest); if (result.kind === 'ready') requiresSourceReview = false; return result; });
    },
    disableSource(expectedAuthorityDigest: string) { return configure(async () => { await assertMain(expectedAuthorityDigest); return sourceController.change({ googleSubject: null }, expectedAuthorityDigest); }); },
    resumeSource: () => configure(() => sourceController.resume()),
    dismissSource: (targetDigest: string, observedHeadDigest: string) => configure(() => sourceController.dismissReviewed(targetDigest, observedHeadDigest)),
    async readOwnCalendar(target: DateTarget) {
      const calendar = await readForPlan(); await port.assertOwner();
      return calendar ? createPrivateCalendarReader(calendar.cache, calendar.binding, now())(target) : { kind: 'unknown' as const, reason: 'missing' as const };
    },
  };
}
export type PrivateCalendarRuntime = ReturnType<typeof createPrivateCalendarRuntime>;
