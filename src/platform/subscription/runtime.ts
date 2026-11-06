import { entitlementSigningText, hasSubscriptionAccess, verifySubscriptionEntitlement } from '../../features/subscription/entitlement';
import type { SignedSubscriptionEntitlement } from '../../features/subscription/entitlement';

export const subscriptionRequired = process.env.EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS === 'required';
export interface SubscriptionSnapshot {
  phase: 'checking' | 'signedOut' | 'locked' | 'active'; userId: string | null;
  entitlement: SignedSubscriptionEntitlement | null; error: string | null;
  account: { appAccountToken: string; obfuscatedAccountId: string } | null;
}
let snapshot: SubscriptionSnapshot = { phase: 'checking', userId: null, entitlement: null, error: null, account: null };
const observers = new Set<() => void>();
let generation = 0; let started: Promise<void> | undefined; let refreshPending: Promise<void> | undefined;
let forcedRefresh = false;
let auth: import('firebase/auth').Auth | undefined;
let vault: typeof import('../sharing/secure-store').sharingSecureVault | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastWall = 0;
let initializationGeneration = 0;
let serverClock: { at: number; monotonicAt: number } | undefined;
const acceptanceQueues = new Map<string, Promise<void>>();
const acceptedProofs = new Map<string, SignedSubscriptionEntitlement>();
let selecting: { userId: string | null; promise: Promise<void> } | undefined;
export const subscriptionSnapshot = () => snapshot;
export function subscribeSubscription(listener: () => void) { observers.add(listener); return () => { observers.delete(listener); }; }
function publish(next: SubscriptionSnapshot) { snapshot = next; for (const observer of observers) observer(); }
/** Abort also bounds identity-provider promises, which do not accept fetch's AbortSignal themselves. */
function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('契約の確認がタイムアウトしました。'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('契約の確認がタイムアウトしました。'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function serverNow() { return serverClock && serverClock.at + Math.max(0, performance.now() - serverClock.monotonicAt); }
function now() { lastWall = Math.max(Math.floor(serverNow() ?? Date.now()), lastWall); return lastWall; }
function acceptServerTime(entitlement: SignedSubscriptionEntitlement) {
  // Only a fresh response from the authenticated HTTPS request may repair an
  // untrusted wall clock. A saved or caller-provided certificate cannot do so.
  const at = Math.max(entitlement.body.checkedAt, Math.floor(serverNow() ?? 0));
  serverClock = { at, monotonicAt: performance.now() }; lastWall = at;
}
function key(userId: string) { if (!/^[A-Za-z0-9_.:@-]{1,128}$/u.test(userId)) throw new Error('利用者を確認できません。'); return `subscription-certificate:${userId}`; }
function configuration() {
  const base = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim().replace(/\/+$/, '');
  const publicKey = process.env.EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY;
  if (!base || !publicKey || !/^[a-f0-9]{64}$/u.test(publicKey)) throw new Error('月額契約の接続先は準備中です。');
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('契約確認の接続先を確認できません。');
  return { base, publicKey };
}
export async function startSubscriptions(): Promise<void> {
  if (!subscriptionRequired) return;
  if (started) return started;
  const attempt = ++initializationGeneration;
  let unsubscribe: (() => void) | undefined;
  const work = (async () => {
    const services = await import('../sharing/firebase-services'); const secure = await import('../sharing/secure-store');
    auth = services.getSharingServices().auth; vault = secure.sharingSecureVault;
    const { onAuthStateChanged } = await import('firebase/auth');
    unsubscribe = onAuthStateChanged(auth, user => { if (attempt === initializationGeneration) void selectAccount(user?.uid ?? null); });
    await auth.authStateReady();
    await selectAccount(auth.currentUser?.uid ?? null);
  })().catch(() => {
    unsubscribe?.();
    if (attempt !== initializationGeneration) return;
    initializationGeneration++; generation++; selecting = undefined; started = undefined;
    publish({ phase: 'locked', userId: null, entitlement: null, account: null, error: '契約の接続先を確認できません。' });
  });
  started = work; return work;
}
function selectAccount(userId: string | null): Promise<void> {
  if (selecting?.userId === userId) return selecting.promise;
  if (snapshot.userId === userId && snapshot.phase !== 'checking') return Promise.resolve();
  const promise = selectAccountImpl(userId); selecting = { userId, promise };
  void promise.finally(() => { if (selecting?.promise === promise) selecting = undefined; }).catch(() => undefined);
  return promise;
}
async function selectAccountImpl(userId: string | null) {
  const current = ++generation; refreshPending = undefined; forcedRefresh = false; clearTimeout(timer);
  publish({ phase: userId ? 'checking' : 'signedOut', userId, entitlement: null, error: null, account: null });
  if (!userId) return;
  try {
    const saved = await vault!.getItem(key(userId)); if (current !== generation) return;
    if (saved) {
      const record = JSON.parse(saved);
      if (!serverClock) lastWall = Math.max(lastWall, record.lastWall ?? 0);
      const known = acceptedProofs.get(userId)?.body;
      const signed = verifySubscriptionEntitlement(record.entitlement, { userId, publicKey: configuration().publicKey, now: now(),
        lastRevision: known?.revision, lastCheckedAt: known?.checkedAt });
      apply(signed);
    } else publish({ ...snapshot, phase: 'locked' });
  } catch { if (current === generation) publish({ ...snapshot, phase: 'locked', error: '保存した契約情報を確認できません。通信して確認してください。' }); }
  if (current === generation) void refreshSubscription().catch(() => undefined);
}
function apply(entitlement: SignedSubscriptionEntitlement) {
  clearTimeout(timer);
  const active = hasSubscriptionAccess(entitlement.body, now());
  publish({ ...snapshot, phase: active ? 'active' : 'locked', entitlement, error: null });
  const current = generation;
  if (active) timer = setTimeout(() => {
    if (current !== generation || snapshot.entitlement?.signature !== entitlement.signature) return;
    apply(entitlement);
    if (snapshot.phase !== 'active') void refreshSubscription().catch(() => undefined);
  }, Math.max(1, entitlement.body.validUntil - now()));
}
export function acceptSubscription(input: unknown): Promise<void> {
  const userId = snapshot.userId; const current = generation;
  const ensureCurrent = () => {
    if (!userId || current !== generation || snapshot.userId !== userId || auth?.currentUser?.uid !== userId) throw new Error('購入時のアカウントで確認してください。');
  };
  try { ensureCurrent(); } catch (error) { return Promise.reject(error); }
  const work = (acceptanceQueues.get(userId!) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    ensureCurrent();
    const previous = [snapshot.entitlement, acceptedProofs.get(userId!)].filter((proof): proof is SignedSubscriptionEntitlement => Boolean(proof))
      .sort((left, right) => right.body.revision - left.body.revision)[0];
    const entitlement = verifySubscriptionEntitlement(input, { userId: userId!, publicKey: configuration().publicKey, now: now(),
      lastRevision: previous?.body.revision, lastCheckedAt: previous?.body.checkedAt });
    if (previous?.body.revision === entitlement.body.revision && entitlementSigningText(previous.body) !== entitlementSigningText(entitlement.body)) throw new Error('同じ版の契約情報が一致しません。');
    const remember = () => {
      acceptedProofs.set(userId!, entitlement);
      if (acceptedProofs.size > 32) acceptedProofs.delete(acceptedProofs.keys().next().value!);
    };
    const denied = !hasSubscriptionAccess(entitlement.body, now());
    if (denied) { remember(); apply(entitlement); }
    try { await vault!.setItem(key(userId!), JSON.stringify({ entitlement, lastWall: now() })); }
    catch (error) {
      if (denied) {
        // Removing a stale grant is a second, independently retryable safeguard.
        // A total storage outage cannot be made durable by a memory-only lock.
        try { await vault!.removeItem(key(userId!)); } catch { /* Keep the verified denial in memory and report the failed save. */ }
        if (current === generation) publish({ ...snapshot, error: '契約の失効は確認済みです。端末への保存を再試行してください。' });
      }
      throw error;
    }
    remember(); ensureCurrent(); apply(entitlement);
  });
  acceptanceQueues.set(userId!, work);
  void work.finally(() => { if (acceptanceQueues.get(userId!) === work) acceptanceQueues.delete(userId!); }).catch(() => undefined);
  return work;
}
export async function subscriptionRequest(path: 'status' | 'verify', evidence?: { store: 'apple' | 'google'; proof: string }, force = false) {
  const user = auth?.currentUser; const current = generation;
  if (!user || user.uid !== snapshot.userId) throw new Error('GoogleまたはAppleでログインしてください。');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const token = await bounded(() => user.getIdToken(), controller.signal);
    if (current !== generation || auth?.currentUser?.uid !== user.uid) throw new Error('ログインしているアカウントが変わりました。');
    const response = await bounded(() => fetch(`${configuration().base}/api/subscriptions/${path}${force ? '?refresh=true' : ''}`, { method: evidence ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(evidence ? { 'content-type': 'application/json' } : {}) },
      ...(evidence ? { body: JSON.stringify(evidence) } : {}), signal: controller.signal, redirect: 'error' }), controller.signal);
    const value = await bounded(() => response.json(), controller.signal);
    if (!response.ok) throw new Error(typeof value.message === 'string' && value.message.length < 500 ? value.message : 'ストアの購入情報を確認できませんでした。');
    if (current !== generation || auth?.currentUser?.uid !== user.uid) throw new Error('購入時のアカウントで確認してください。');
    const previous = snapshot.entitlement?.body;
    const entitlement = verifySubscriptionEntitlement(value.entitlement, { userId: user.uid, publicKey: configuration().publicKey,
      now: value.entitlement?.body?.checkedAt, lastRevision: previous?.revision, lastCheckedAt: previous?.checkedAt });
    acceptServerTime(entitlement);
    if (path === 'status') await acceptSubscription(entitlement);
    if (typeof value.account?.appAccountToken !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.account.appAccountToken)
      || !/^[a-f0-9]{64}$/u.test(value.account.obfuscatedAccountId)) throw new Error('購入するアカウントを確認できません。');
    publish({ ...snapshot, account: { ...value.account } }); return entitlement;
  } finally { clearTimeout(timeout); }
}
export function refreshSubscription(options: { force?: boolean } = {}): Promise<void> {
  if (!subscriptionRequired) return Promise.resolve();
  if (refreshPending && (!options.force || forcedRefresh)) return refreshPending;
  const current = generation;
  const previous = refreshPending;
  const work = (previous ?? Promise.resolve()).then(() => {
    if (current !== generation) return;
    return subscriptionRequest('status', undefined, options.force === true);
  }).then(() => undefined).catch(() => {
    if (current === generation) publish({ ...snapshot, error: '契約状態を更新できませんでした。通信を確認して再試行してください。' });
  });
  refreshPending = work; forcedRefresh = options.force === true;
  void work.finally(() => { if (refreshPending === work) { refreshPending = undefined; forcedRefresh = false; } }); return work;
}
export async function subscriptionAccessDeadline(): Promise<number> {
  if (!subscriptionRequired) return Infinity;
  await startSubscriptions();
  if (snapshot.userId && !hasSubscriptionAccess(snapshot.entitlement?.body ?? null, now())) await refreshSubscription();
  if (auth?.currentUser?.uid !== snapshot.userId || !hasSubscriptionAccess(snapshot.entitlement?.body ?? null, now())) return 0;
  return snapshot.entitlement!.body.validUntil;
}
export async function assertSubscriptionAccess(): Promise<void> {
  if (await subscriptionAccessDeadline() <= now()) throw new Error('有効なLiFlowの契約が必要です。購入・復元画面で確認してください。');
}
