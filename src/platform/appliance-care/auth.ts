import { randomUUID } from 'expo-crypto';
import { getSharingServices, isSharingConfigured } from '../sharing/firebase-services';

export interface ApplianceApiSession {
  headers(): Promise<Record<string, string>>;
}

function failure(message: string) { return Object.assign(new Error(message), { code: 'AUTHENTICATION_REQUIRED' }); }

/** The API reuses the app account; it never creates a separate AI login. */
export async function authorizeApplianceCareApi(baseUrl: string): Promise<ApplianceApiSession> {
  try { return await createSession(baseUrl); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'AUTHENTICATION_REQUIRED') throw error;
    throw failure('家電AIの利用者認証に接続できませんでした。通信状態を確認して再試行してください。');
  }
}

async function createSession(baseUrl: string): Promise<ApplianceApiSession> {
  const url = new URL(baseUrl);
  const configured = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !configured || new URL(configured).origin !== url.origin) {
    throw failure('家電AIのHTTPS接続先が設定されていません。');
  }
  if (!isSharingConfigured()) throw failure('家電AIの利用者認証が設定されていません。');
  const sharedAuth = getSharingServices().auth;
  await sharedAuth.authStateReady();
  const user = sharedAuth.currentUser;
  if (!user || user.isAnonymous) throw failure('家電AIを利用するにはGoogleまたはAppleでログインしてください。');
  const requestId = randomUUID();
  const current = () => sharedAuth.currentUser?.uid === user.uid;
  return { async headers() {
    if (!current()) throw failure('利用者が切り替わりました。もう一度解析してください。');
    let token;
    try { token = await user.getIdToken(); }
    catch { throw failure('利用者認証を更新できませんでした。通信状態を確認して再試行してください。'); }
    if (!current()) throw failure('利用者が切り替わりました。もう一度解析してください。');
    return { authorization: `Bearer ${token}`, 'x-idempotency-key': requestId };
  } };
}

/** Verified zero-use bindings matter too: merely waiting to run the first analysis must not replace the first account. */
export async function bindApplianceAccount(uid: string): Promise<import('../../features/appliance-care/api-contracts').ApplianceCareUsage> {
  const baseUrl = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl) throw failure('家電AIの接続先が未設定のため、端末との紐づけはまだ確認できません。');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const { isApplianceCareUsage, abortApplianceWait } = await import('../../features/appliance-care/api-client');
    const session = await abortApplianceWait(() => authorizeApplianceCareApi(baseUrl), controller.signal);
    if (getSharingServices().auth.currentUser?.uid !== uid) throw failure('利用者が切り替わりました。');
    const headers = await abortApplianceWait(() => session.headers(), controller.signal);
    controller.signal.throwIfAborted();
    const response = await abortApplianceWait(() => fetch(`${baseUrl}/api/appliance-care/usage`, { headers, signal: controller.signal, redirect: 'error' }), controller.signal);
    const body: unknown = await abortApplianceWait(() => response.json(), controller.signal);
    if (!response.ok || !body || typeof body !== 'object' || !('usage' in body) || !isApplianceCareUsage(body.usage)) {
      throw failure('正規端末とアカウントの紐づけを確認できません。家電AIは利用できません。');
    }
    if (getSharingServices().auth.currentUser?.uid !== uid) throw failure('利用者が切り替わりました。');
    return body.usage;
  } finally { clearTimeout(timer); }
}
