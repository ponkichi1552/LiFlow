import { requireOptionalNativeModule } from 'expo';
import { getAndroidId } from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const vault = { keychainService: 'jp.jphacks.tkb2633.appliance', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const keychainEntry = 'appliance-app-attest-key';
const proofCodes = ['DEVICE_VERIFICATION_REQUIRED', 'DEVICE_VERIFICATION_UNAVAILABLE', 'DEVICE_VERIFICATION_TEMPORARY',
  'REINSTALL_ACCOUNT_LOCKED', 'AUTHENTICATION_REQUIRED', 'ACCESS_DENIED', 'SUBSCRIPTION_REQUIRED', 'TEMPORARY_NETWORK_ERROR'] as const;
const unavailable = () => Object.assign(new Error('正規アプリと端末を確認できませんでした。'), { code: 'DEVICE_VERIFICATION_UNAVAILABLE' });
const temporary = () => Object.assign(new Error('端末の確認に時間がかかっています。少し待ってお試しください。'), { code: 'DEVICE_VERIFICATION_TEMPORARY' });
let queue = Promise.resolve<unknown>(undefined);
let cached: { scope: string; grant: string; validBefore: number } | undefined;
let playProviderUntil = 0;
let pendingAttestation: { scope: string; keyId: string; challenge: string; queryToken: string; updateToken: string; expires: number; proof?: string } | undefined;

async function nativeReply<T>(work: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(temporary()), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

async function request(baseUrl: string, authorization: string, path: 'challenge' | 'grant', body: object) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${baseUrl}/api/appliance-care/device/${path}`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(body), signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok) {
      if (proofCodes.some(code => code === value?.code) && typeof value?.message === 'string') {
        throw Object.assign(new Error(value.message), { code: value.code, retryAt: typeof value.retryAt === 'string' ? value.retryAt : undefined });
      }
      if (response.status === 429 || response.status >= 500) throw temporary();
      throw unavailable();
    }
    return value;
  } finally { clearTimeout(timeout); }
}

async function appleGrant(baseUrl: string, authorization: string, admissionId?: string, scope?: string) {
  const integrity = await import('@expo/app-integrity');
  if (!integrity.isSupported) throw unavailable();
  const device = requireOptionalNativeModule<{ generateToken(): Promise<string> }>('LiFlowDeviceCheck');
  if (!device) throw unavailable();

  async function prove(allowReplacement: boolean): Promise<{ grant: string; ttlMs: number }> {
    let keyId = await nativeReply(SecureStore.getItemAsync(keychainEntry, vault));
    if (!keyId) {
      keyId = await nativeReply(integrity.generateKeyAsync());
      await nativeReply(SecureStore.setItemAsync(keychainEntry, keyId, vault));
    }
    const ticket = JSON.stringify([scope, admissionId]);
    const saved = pendingAttestation?.scope === ticket && pendingAttestation?.keyId === keyId && pendingAttestation.expires > performance.now() ? pendingAttestation : undefined;
    // Keep Apple's clientDataHash stable on a pre-attestation outage. If a proof
    // was sent, check whether the API recorded the key before retrying enrollment.
    const next = saved && !saved.proof ? { challenge: saved.challenge, mode: 'attest' }
      : await request(baseUrl, authorization, 'challenge', { platform: 'ios', keyId, admissionId });
    const { mode } = next;
    const challenge = mode === 'attest' && saved ? saved.challenge : next.challenge;
    if (typeof challenge !== 'string' || challenge.length > 2048 || !['attest', 'assert', 'assert-and-mark'].includes(mode)) throw unavailable();
    const deviceTokens = mode === 'assert' ? undefined : mode === 'attest' && saved ? { queryToken: saved.queryToken, updateToken: saved.updateToken }
      : { queryToken: await nativeReply(device!.generateToken()), updateToken: await nativeReply(device!.generateToken()) };
    const message = deviceTokens ? JSON.stringify([challenge, deviceTokens.queryToken, deviceTokens.updateToken]) : challenge;
    pendingAttestation = mode === 'attest' && deviceTokens ? saved ?? { scope: ticket, keyId, challenge, ...deviceTokens, expires: performance.now() + 100_000 } : undefined;
    let proof;
    try {
      proof = mode === 'attest' ? saved?.proof ?? await nativeReply(integrity.attestKeyAsync(keyId, message))
        : await nativeReply(integrity.generateAssertionAsync(keyId, message));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ERR_APP_INTEGRITY_SERVER_UNAVAILABLE' || code === 'DEVICE_VERIFICATION_TEMPORARY') throw temporary();
      if (!allowReplacement || code !== 'ERR_APP_INTEGRITY_INVALID_KEY') throw unavailable();
      pendingAttestation = undefined;
      await nativeReply(SecureStore.deleteItemAsync(keychainEntry, vault));
      return prove(false);
    }
    if (mode === 'attest' && pendingAttestation) pendingAttestation.proof = proof;
    const result = await request(baseUrl, authorization, 'grant', { challenge, proof, ...deviceTokens });
    pendingAttestation = undefined;
    return result;
  }
  return prove(true);
}

async function androidGrant(baseUrl: string, authorization: string, admissionId?: string) {
  const project = process.env.EXPO_PUBLIC_APPLIANCE_PLAY_PROJECT_NUMBER;
  const id = getAndroidId().toLowerCase();
  if (!project || !/^[0-9]{6,20}$/u.test(project) || !/^[a-f0-9]{16}$/u.test(id)) throw unavailable();
  const signing = requireOptionalNativeModule<{
    publicKey(): Promise<string>;
    sign(message: string): Promise<string>;
    attestedPublicKey(): Promise<string | null>;
    attestKey(challenge: string): Promise<{ publicKey: string; certificateChain: string[] }>;
    signAttested(message: string): Promise<string>;
  }>('LiFlowApplianceSigning');
  if (!signing || typeof signing.attestKey !== 'function') throw unavailable();
  const digest = (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  const [publicKey, attestedKey] = await Promise.all([nativeReply(signing.publicKey()), nativeReply(signing.attestedPublicKey())]);
  const [installation, device] = await Promise.all([digest(publicKey), digest(`liflow-appliance:${id}`)]);
  let hardwareKeyId = attestedKey ? await digest(attestedKey) : undefined;
  const keyId = `${device}.${installation}`;
  const integrity = await import('@expo/app-integrity');
  async function warm() {
    await nativeReply(integrity.prepareIntegrityTokenProviderAsync(project!));
    playProviderUntil = performance.now() + 3 * 60_000;
  }
  async function prove(value: { challenge: string; mode: string }, allowedModes: readonly string[]) {
    const { challenge, mode } = value;
    if (typeof challenge !== 'string' || challenge.length > 2048 || !allowedModes.includes(mode)) throw unavailable();
    // Play caches Device Recall at warmup. Enrollment rewarms after the server grants its exclusive lease.
    const [attestation] = await Promise.all([
      mode === 'attest' ? nativeReply(signing!.attestKey(challenge), 35_000) : undefined,
      mode === 'enroll' || playProviderUntil <= performance.now() ? warm() : undefined,
    ]);
    if (attestation) hardwareKeyId = await digest(attestation.publicKey);
    if (!hardwareKeyId) throw unavailable();
    const message = JSON.stringify([challenge, keyId, hardwareKeyId]);
    const [hash, signature, hardwareSignature] = await Promise.all([
      digest(message), nativeReply(signing!.sign(message)), nativeReply(signing!.signAttested(message)),
    ]);
    let proof;
    try { proof = await nativeReply(integrity.requestIntegrityCheckAsync(hash)); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ERR_APP_INTEGRITY_PROVIDER_INVALID') throw error;
      await warm(); proof = await nativeReply(integrity.requestIntegrityCheckAsync(hash));
    }
    try { return await request(baseUrl, authorization, 'grant', {
      challenge, proof, publicKey, signature, hardwareKeyId, hardwareSignature, certificateChain: attestation?.certificateChain,
    }); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DEVICE_VERIFICATION_TEMPORARY') playProviderUntil = 0;
      throw error;
    } finally { if (mode === 'enroll') playProviderUntil = 0; }
  }
  const first = await prove(await request(baseUrl, authorization, 'challenge', { platform: 'android', keyId, hardwareKeyId, admissionId }), ['attest', 'prove']);
  return first?.mode === 'enroll' ? prove(first, ['enroll']) : first;
}

export function applianceDeviceGrant(baseUrl: string, owner: string, authorization: string, admissionId?: string): Promise<string> {
  const scope = JSON.stringify([baseUrl, owner]);
  const obtain = async () => {
    if (!admissionId && cached?.scope === scope && cached.validBefore > performance.now()) return cached.grant;
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw unavailable();
    const { grant, ttlMs } = await (Platform.OS === 'ios' ? appleGrant(baseUrl, authorization, admissionId, scope) : androidGrant(baseUrl, authorization, admissionId));
    if (typeof grant !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(grant) || grant.length > 2048
      || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 12 * 60_000) throw unavailable();
    if (!admissionId) cached = { scope, grant, validBefore: performance.now() + Math.max(0, ttlMs - 15_000) };
    return grant;
  };
  // App Attest assertions of one key must be verified in the same order as they were made.
  const pending = queue.then(obtain, obtain);
  queue = pending;
  return pending;
}
