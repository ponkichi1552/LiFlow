import type { DevicePublicIdentity } from './crypto.ts';
import { verifySharedDocument } from './crypto.ts';
import { canonicalJson } from './operations.ts';

export const DELIVERY_TTL_MS = 24 * 60 * 60_000;
export const DELIVERY_PROOF_COLLECTION = 'signedDeliveryDevices';
const digest = /^[a-f0-9]{64}$/u;
const signature = /^[a-f0-9]{128}$/u;

export interface DeliveryPolicy { schemaVersion: 2; enrollmentId: string; enabled: boolean; ttlMs: number }
export interface DeliveryScope {
  projectId: string; kind: 'shared' | 'private'; scopeId: string;
  enrollmentId: string; authorityDigest: string; keyVersion: number;
}
export interface SharedDeliveryProgress { sequence: number; snapshotId: string | null; snapshotDigest: string | null }
export interface PrivateDeliveryProgress { ready: boolean; calendarDigest: string | null; preferencesDigest: string | null }
export interface DeliveryRequestReference {
  id: string; kind: 'events' | 'chunk'; key: string; after: number; through: number; keyVersion: number;
  createdSeconds: number; createdNanoseconds: number;
}
export type DeviceDeliverySigner = (value: unknown) => string | Promise<string>;
export type SignedDeliveryProgress<T> = {
  schemaVersion: 2; userId: string; deviceId: string; enrollmentId: string; authorityDigest: string;
  keyVersion: number; progress: T; signature: string;
};

export function parseDeliveryPolicy(raw: unknown): DeliveryPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<DeliveryPolicy>;
  return value.schemaVersion === 2 && typeof value.enabled === 'boolean' && value.ttlMs === DELIVERY_TTL_MS
    && typeof value.enrollmentId === 'string' && digest.test(value.enrollmentId) ? value as DeliveryPolicy : null;
}

function stateDocument<T>(scope: DeliveryScope, userId: string, deviceId: string, progress: T) {
  return { schemaVersion: 2 as const, userId, deviceId, enrollmentId: scope.enrollmentId,
    authorityDigest: scope.authorityDigest, keyVersion: scope.keyVersion, progress };
}

function stateSignatureInput(scope: DeliveryScope, document: Omit<SignedDeliveryProgress<unknown>, 'signature'>) {
  return { domain: 'liflow-delivery-device-state-v2', scope, document };
}

export async function signDeliveryProgress<T extends SharedDeliveryProgress | PrivateDeliveryProgress>(scope: DeliveryScope,
  userId: string, deviceId: string, progress: T, sign: DeviceDeliverySigner): Promise<SignedDeliveryProgress<T>> {
  const document = stateDocument(scope, userId, deviceId, progress);
  return { ...document, signature: await sign(stateSignatureInput(scope, document)) };
}

export function readSignedDeliveryProgress(scope: DeliveryScope, userId: string, device: DevicePublicIdentity,
  raw: unknown): SharedDeliveryProgress | PrivateDeliveryProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const { signature: proof, updatedAt: _updatedAt, ...document } = raw as SignedDeliveryProgress<unknown> & { updatedAt?: unknown };
  const { progress } = document;
  if (typeof proof !== 'string' || !signature.test(proof) || !progress || typeof progress !== 'object') return null;
  const value = progress as Record<string, unknown>;
  const validDigest = (entry: unknown) => entry === null || typeof entry === 'string' && digest.test(entry);
  const valid = scope.kind === 'shared'
    ? Object.keys(value).length === 3 && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
      && (value.snapshotId === null || typeof value.snapshotId === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/u.test(value.snapshotId))
      && validDigest(value.snapshotDigest) && (value.snapshotId === null) === (value.snapshotDigest === null)
    : Object.keys(value).length === 3 && typeof value.ready === 'boolean' && validDigest(value.calendarDigest) && validDigest(value.preferencesDigest);
  if (!valid) return null;
  try {
    if (canonicalJson(document) !== canonicalJson(stateDocument(scope, userId, device.deviceId, progress))) return null;
    verifySharedDocument(stateSignatureInput(scope, document), proof, device);
    return progress as SharedDeliveryProgress | PrivateDeliveryProgress;
  } catch { return null; }
}

export function recoveryReceiptInput(scope: DeliveryScope, userId: string, deviceId: string, request: DeliveryRequestReference) {
  return { domain: 'liflow-delivery-recovery-receipt-v2', scope, userId, deviceId, request };
}

export function validRecoveryReceipt(scope: DeliveryScope, userId: string, device: DevicePublicIdentity,
  request: DeliveryRequestReference, proof: unknown): boolean {
  if (typeof proof !== 'string' || !signature.test(proof) || request.keyVersion !== scope.keyVersion) return false;
  try {
    verifySharedDocument(recoveryReceiptInput(scope, userId, device.deviceId, request), proof, device);
    return true;
  } catch { return false; }
}
