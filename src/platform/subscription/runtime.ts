import { hasSubscriptionAccess, verifySubscriptionEntitlement } from '../../features/subscription/entitlement';
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
function now() { lastWall = Math.max(Date.now(), lastWall); return lastWall; }
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
  started = (async () => {
    const services = await import('../sharing/firebase-services'); const secure = await import('../sharing/secure-store');
    auth = services.getSharingServices().auth; vault = secure.sharingSecureVault;
    const { onAuthStateChanged } = await import('firebase/auth');
    onAuthStateChanged(auth, user => { void selectAccount(user?.uid ?? null); });
    await auth.authStateReady();
    await selectAccount(auth.currentUser?.uid ?? null);
  })().catch(() => { publish({ ...snapshot, phase: 'locked', error: '契約の接続先を確認できません。' }); });
  return started;
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
      const record = JSON.parse(saved); lastWall = Math.max(lastWall, record.lastWall ?? 0);
      const signed = verifySubscriptionEntitlement(record.entitlement, { userId, publicKey: configuration().publicKey, now: now() });
      apply(signed);
    } else publish({ ...snapshot, phase: 'locked' });
  } catch { if (current === generation) publish({ ...snapshot, phase: 'locked', error: '保存した契約情報を確認できません。通信して確認してください。' }); }
  if (current === generation) void refreshSubscription().catch(() => undefined);
}
function apply(entitlement: SignedSubscriptionEntitlement) {
  clearTimeout(timer);
  const active = hasSubscriptionAccess(entitlement.body, now());
  publish({ ...snapshot, phase: active ? 'active' : 'locked', entitlement, error: null });
  if (active) timer = setTimeout(() => {
    publish({ ...snapshot, phase: 'locked' }); void refreshSubscription().catch(() => undefined);
  }, Math.max(1, entitlement.body.validUntil - now()));
}
export async function acceptSubscription(input: unknown): Promise<void> {
  const userId = snapshot.userId; if (!userId || auth?.currentUser?.uid !== userId) throw new Error('ログインしているアカウントが変わりました。');
  const previous = snapshot.entitlement?.body;
  const entitlement = verifySubscriptionEntitlement(input, { userId, publicKey: configuration().publicKey, now: now(),
    lastRevision: previous?.revision, lastCheckedAt: previous?.checkedAt });
  const current = generation;
  await vault!.setItem(key(userId), JSON.stringify({ entitlement, lastWall: now() }));
  if (generation !== current || auth.currentUser?.uid !== userId) throw new Error('購入時のアカウントで確認してください。');
  apply(entitlement);
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
      now: now(), lastRevision: previous?.revision, lastCheckedAt: previous?.checkedAt });
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
