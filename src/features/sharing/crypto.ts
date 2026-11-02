import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { assertJsonRecord, assertSharedIdentifier, canonicalJson, MAX_OPERATION_BYTES, validateSharedOperation } from './operations.ts';
import type { SharedOperation } from './operations.ts';
import { sharedContentDigest } from './content-digest.ts';
import { signatureVerificationCache } from './signature-verification-cache.ts';

export interface SharingCryptoGateway {
  randomBytes(length: number): Promise<Uint8Array>;
  encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  decrypt(key: Uint8Array, nonce: Uint8Array, ciphertextWithTag: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}
export interface DevicePublicIdentity { deviceId: string; signingPublicKey: string; agreementPublicKey: string }
export interface DeviceSecretIdentity extends DevicePublicIdentity { signingSecretKey: string; agreementSecretKey: string }
export interface AuthenticatedSharedOperation { operation: SharedOperation; authorSignature: string }
export interface EncryptedSharedOperation {
  schemaVersion: 1 | 2;
  suite: 'liflow-aes256gcm-hkdfsha256-ed25519-v1';
  operationId: string;
  groupId: string;
  authorUserId: string;
  authorDeviceId: string;
  keyVersion: number;
  logicalClock: number;
  salt: string;
  nonce: string;
  encryptedPayload: string;
  signature: string;
}
export interface WrappedGroupKey {
  schemaVersion: 1;
  suite: 'liflow-x25519-hkdfsha256-aes256gcm-ed25519-v1';
  groupId: string;
  keyVersion: number;
  senderDeviceId: string;
  recipientDeviceId: string;
  recipientUserId: string;
  ephemeralPublicKey: string;
  salt: string;
  nonce: string;
  encryptedKey: string;
  signature: string;
}
export interface EncryptedSharedSnapshotChunk {
  schemaVersion: 1;
  suite: 'liflow-snapshot-aes256gcm-hkdfsha256-ed25519-v1';
  groupId: string;
  snapshotId: string;
  chunkIndex: number;
  keyVersion: number;
  ownerDeviceId: string;
  salt: string;
  nonce: string;
  encryptedPayload: string;
  signature: string;
}
export const MAX_SHARED_SNAPSHOT_CHUNK_BYTES = 320 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function utf8(value: unknown): Uint8Array { return encoder.encode(canonicalJson(value)); }
function bytes(hex: string, length?: number): Uint8Array {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/u.test(hex) || (length && hex.length !== length * 2)) {
    throw new Error('Invalid cryptographic encoding');
  }
  return hexToBytes(hex);
}
function positive(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid cryptographic version or clock'); }
function publicIdentity(signingPublicKey: string, agreementPublicKey: string): DevicePublicIdentity {
  bytes(signingPublicKey, 32); bytes(agreementPublicKey, 32);
  return { deviceId: `device-${sharedContentDigest({ signingPublicKey, agreementPublicKey })}`,
    signingPublicKey, agreementPublicKey };
}
export function validateDevicePublicIdentity(identity: DevicePublicIdentity): DevicePublicIdentity {
  const expected = publicIdentity(identity.signingPublicKey, identity.agreementPublicKey);
  if (identity.deviceId !== expected.deviceId) throw new Error('Device public key fingerprint mismatch');
  return expected;
}
export async function createDeviceIdentity(crypto: SharingCryptoGateway): Promise<DeviceSecretIdentity> {
  const signing = await crypto.randomBytes(32); const agreement = await crypto.randomBytes(32);
  if (signing.length !== 32 || agreement.length !== 32) throw new Error('Secure random source failed');
  return { ...publicIdentity(bytesToHex(ed25519.getPublicKey(signing)), bytesToHex(x25519.getPublicKey(agreement))),
    signingSecretKey: bytesToHex(signing), agreementSecretKey: bytesToHex(agreement) };
}
export function validateDeviceSecretIdentity(identity: DeviceSecretIdentity): DeviceSecretIdentity {
  const pub = validateDevicePublicIdentity(identity);
  if (bytesToHex(ed25519.getPublicKey(bytes(identity.signingSecretKey, 32))) !== pub.signingPublicKey
    || bytesToHex(x25519.getPublicKey(bytes(identity.agreementSecretKey, 32))) !== pub.agreementPublicKey) {
    throw new Error('Device secret and public keys do not match');
  }
  return { ...pub, signingSecretKey: identity.signingSecretKey, agreementSecretKey: identity.agreementSecretKey };
}

// A signature's mathematical validity is independent of current membership.
// Keep only positive, content-bound results; callers still check authority and
// revocation. Canonical signed bytes stay in bounded process memory only;
// secret keys and permission decisions are never cached.
const verifiedSignatures = new Map<string, string>();
let verifiedSignatureBytes = 0;
const maximumSignatureBytes = 8 * 1024 * 1024;
const signatureWeight = (text: string) => text.length * 2 + 256;
function verify(value: unknown, signature: string, trusted: DevicePublicIdentity): void {
  const identity = { deviceId: trusted.deviceId, signingPublicKey: trusted.signingPublicKey, agreementPublicKey: trusted.agreementPublicKey };
  validateDevicePublicIdentity(identity);
  const signatureBytes = bytes(signature, 64); const publicKey = bytes(identity.signingPublicKey, 32);
  const text = canonicalJson(value); const key = `${identity.signingPublicKey}:${signature}`;
  const cached = verifiedSignatures.get(key);
  // Exact text equality avoids hashing a large snapshot merely to find its
  // already-verified signature. Reusing a signature with changed bytes still verifies.
  if (cached === text) { verifiedSignatures.delete(key); verifiedSignatures.set(key, text); return; }
  if (!signatureVerificationCache.has(identity.signingPublicKey, signature, text)) {
    if (!ed25519.verify(signatureBytes, encoder.encode(text), publicKey, { zip215: false })) {
      throw new Error('Shared signature authentication failed');
    }
    signatureVerificationCache.rememberVerified(identity.signingPublicKey, signature, text);
  }
  const size = signatureWeight(text); if (size > maximumSignatureBytes) return;
  if (cached !== undefined) { verifiedSignatures.delete(key); verifiedSignatureBytes -= signatureWeight(cached); }
  while (verifiedSignatures.size >= 1024 || verifiedSignatureBytes + size > maximumSignatureBytes) {
    const oldest = verifiedSignatures.keys().next().value!;
    verifiedSignatureBytes -= signatureWeight(verifiedSignatures.get(oldest)!); verifiedSignatures.delete(oldest);
  }
  verifiedSignatures.set(key, text); verifiedSignatureBytes += size;
}
export function signSharedDocument(value: unknown, identity: DeviceSecretIdentity): string {
  validateDeviceSecretIdentity(identity);
  return bytesToHex(ed25519.sign(utf8(value), bytes(identity.signingSecretKey, 32)));
}
export function verifySharedDocument(value: unknown, signature: string, trusted: DevicePublicIdentity): void { verify(value, signature, trusted); }
export function sharedDocumentDigest(value: unknown): string { return sharedContentDigest(value); }

export async function sealSharedSnapshotChunk(crypto: SharingCryptoGateway, plaintext: Uint8Array,
  context: { groupId: string; snapshotId: string; chunkIndex: number; keyVersion: number },
  groupKey: Uint8Array, owner: DeviceSecretIdentity): Promise<EncryptedSharedSnapshotChunk> {
  assertSharedIdentifier(context.groupId); assertSharedIdentifier(context.snapshotId); positive(context.keyVersion);
  validateDeviceSecretIdentity(owner);
  if (groupKey.length !== 32 || plaintext.length > MAX_SHARED_SNAPSHOT_CHUNK_BYTES || !Number.isSafeInteger(context.chunkIndex)
    || context.chunkIndex < 0 || context.chunkIndex >= 512) throw new Error('Invalid snapshot encryption context');
  const salt = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
  if (salt.length !== 32 || nonce.length !== 12) throw new Error('Secure random source failed');
  const header = { schemaVersion: 1 as const, suite: 'liflow-snapshot-aes256gcm-hkdfsha256-ed25519-v1' as const,
    ...context, ownerDeviceId: owner.deviceId, salt: bytesToHex(salt), nonce: bytesToHex(nonce) };
  const aad = utf8(header); const key = hkdf(sha256, groupKey, salt, aad, 32);
  try {
    const unsigned = { ...header, encryptedPayload: bytesToHex(await crypto.encrypt(key, nonce, plaintext, aad)) };
    return { ...unsigned, signature: signSharedDocument(unsigned, owner) };
  } finally { key.fill(0); }
}

export async function openSharedSnapshotChunk(crypto: SharingCryptoGateway, input: EncryptedSharedSnapshotChunk,
  context: { groupId: string; snapshotId: string; chunkIndex: number; keyVersion: number },
  groupKey: Uint8Array, owner: DevicePublicIdentity): Promise<Uint8Array> {
  if (Object.keys(input).sort().join(',') !== 'chunkIndex,encryptedPayload,groupId,keyVersion,nonce,ownerDeviceId,salt,schemaVersion,signature,snapshotId,suite') {
    throw new Error('Unknown snapshot envelope field');
  }
  const { signature, encryptedPayload, ...header } = input;
  if (header.schemaVersion !== 1 || header.suite !== 'liflow-snapshot-aes256gcm-hkdfsha256-ed25519-v1'
    || header.ownerDeviceId !== owner.deviceId || groupKey.length !== 32
    || Object.entries(context).some(([key, value]) => header[key as keyof typeof header] !== value)
    || typeof encryptedPayload !== 'string' || encryptedPayload.length > (MAX_SHARED_SNAPSHOT_CHUNK_BYTES + 16) * 2) {
    throw new Error('Snapshot encryption context mismatch');
  }
  verify({ ...header, encryptedPayload }, signature, owner);
  const salt = bytes(header.salt, 32); const nonce = bytes(header.nonce, 12); const aad = utf8(header);
  const key = hkdf(sha256, groupKey, salt, aad, 32);
  try { return await crypto.decrypt(key, nonce, bytes(encryptedPayload), aad); }
  finally { key.fill(0); }
}

/** Preserve the original author's proof inside snapshots, even after transport keys rotate. */
export function signSharedOperation(raw: SharedOperation, identity: DeviceSecretIdentity): AuthenticatedSharedOperation {
  const operation = validateSharedOperation(raw);
  if (operation.authorDeviceId !== identity.deviceId) throw new Error('Shared signing identity mismatch');
  return { operation, authorSignature: signSharedDocument({ domain: 'liflow-shared-operation-v1', operation }, identity) };
}

export function verifyAuthenticatedSharedOperation(
  fact: AuthenticatedSharedOperation, trusted: DevicePublicIdentity, expectedGroupId: string,
): AuthenticatedSharedOperation {
  assertJsonRecord(fact);
  if (Object.keys(fact).sort().join(',') !== 'authorSignature,operation') throw new Error('Unknown authenticated operation field');
  const operation = validateSharedOperation(fact.operation, expectedGroupId);
  if (operation.authorDeviceId !== trusted.deviceId) throw new Error('Shared signing identity mismatch');
  verify({ domain: 'liflow-shared-operation-v1', operation }, fact.authorSignature, trusted);
  return { operation, authorSignature: fact.authorSignature };
}

/** Per-message derivation also isolates messages if two random nonces happen to coincide. */
export async function encryptSharedOperation(
  crypto: SharingCryptoGateway, raw: SharedOperation, groupKey: Uint8Array, identity: DeviceSecretIdentity,
  transportKeyVersion = raw.keyVersion,
): Promise<EncryptedSharedOperation> {
  const op = validateSharedOperation(raw); validateDeviceSecretIdentity(identity);
  if (groupKey.length !== 32 || op.authorDeviceId !== identity.deviceId) throw new Error('Shared encryption identity mismatch');
  positive(transportKeyVersion);
  if (transportKeyVersion < op.keyVersion) throw new Error('Cannot encrypt an operation under an older group key');
  const salt = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
  if (salt.length !== 32 || nonce.length !== 12) throw new Error('Secure random source failed');
  const header = { schemaVersion: op.schemaVersion, suite: 'liflow-aes256gcm-hkdfsha256-ed25519-v1' as const,
    operationId: op.operationId, groupId: op.groupId, authorUserId: op.authorUserId, authorDeviceId: op.authorDeviceId,
    keyVersion: transportKeyVersion, logicalClock: op.logicalClock, salt: bytesToHex(salt), nonce: bytesToHex(nonce) };
  const aad = utf8(header);
  const key = hkdf(sha256, groupKey, salt, aad, 32);
  try {
    const encryptedPayload = bytesToHex(await crypto.encrypt(key, nonce, utf8(signSharedOperation(op, identity)), aad));
    const unsigned = { ...header, encryptedPayload };
    return { ...unsigned, signature: signSharedDocument(unsigned, identity) };
  } finally { key.fill(0); }
}

export async function decryptAuthenticatedSharedOperation(
  crypto: SharingCryptoGateway, envelope: EncryptedSharedOperation, groupKey: Uint8Array,
  trusted: DevicePublicIdentity, expectedGroupId: string, expectedKeyVersion: number,
): Promise<AuthenticatedSharedOperation> {
  const { signature, encryptedPayload, ...header } = envelope;
  if (Object.keys(envelope).sort().join(',') !== 'authorDeviceId,authorUserId,encryptedPayload,groupId,keyVersion,logicalClock,nonce,operationId,salt,schemaVersion,signature,suite') {
    throw new Error('Unknown encrypted envelope field');
  }
  if (![1, 2].includes(header.schemaVersion) || header.suite !== 'liflow-aes256gcm-hkdfsha256-ed25519-v1'
    || header.groupId !== expectedGroupId || header.keyVersion !== expectedKeyVersion
    || header.authorDeviceId !== trusted.deviceId || groupKey.length !== 32) throw new Error('Shared encryption context mismatch');
  for (const id of [header.operationId, header.groupId, header.authorUserId, header.authorDeviceId]) assertSharedIdentifier(id);
  positive(header.keyVersion); positive(header.logicalClock);
  if (typeof encryptedPayload !== 'string' || encryptedPayload.length > (MAX_OPERATION_BYTES + 1024) * 2) throw new Error('Ciphertext is too large');
  verify({ ...header, encryptedPayload }, signature, trusted);
  const nonce = bytes(header.nonce, 12); const salt = bytes(header.salt, 32); const aad = utf8(header);
  const key = hkdf(sha256, groupKey, salt, aad, 32);
  try {
    const plaintext = await crypto.decrypt(key, nonce, bytes(encryptedPayload), aad);
    const fact = verifyAuthenticatedSharedOperation(JSON.parse(decoder.decode(plaintext)), trusted, expectedGroupId);
    const op = fact.operation;
    if (op.schemaVersion !== header.schemaVersion) throw new Error('Operation schema differs from its authenticated envelope');
    if (op.keyVersion > header.keyVersion) throw new Error('Operation authoring epoch is newer than its transport key');
    for (const name of ['operationId', 'authorUserId', 'authorDeviceId', 'logicalClock'] as const) {
      if (op[name] !== header[name]) throw new Error('Decrypted operation header mismatch');
    }
    return fact;
  } finally { key.fill(0); }
}

export async function decryptSharedOperation(
  crypto: SharingCryptoGateway, envelope: EncryptedSharedOperation, groupKey: Uint8Array,
  trusted: DevicePublicIdentity, expectedGroupId: string, expectedKeyVersion: number,
): Promise<SharedOperation> {
  return (await decryptAuthenticatedSharedOperation(crypto, envelope, groupKey, trusted, expectedGroupId, expectedKeyVersion)).operation;
}

export async function wrapGroupKey(
  crypto: SharingCryptoGateway, groupId: string, keyVersion: number, groupKey: Uint8Array,
  sender: DeviceSecretIdentity, recipient: DevicePublicIdentity, recipientUserId: string,
): Promise<WrappedGroupKey> {
  assertSharedIdentifier(groupId); assertSharedIdentifier(recipientUserId); positive(keyVersion);
  validateDeviceSecretIdentity(sender); validateDevicePublicIdentity(recipient);
  if (groupKey.length !== 32) throw new Error('Invalid group key');
  const ephemeral = await crypto.randomBytes(32); const salt = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
  if (ephemeral.length !== 32 || salt.length !== 32 || nonce.length !== 12) throw new Error('Secure random source failed');
  const shared = x25519.getSharedSecret(ephemeral, bytes(recipient.agreementPublicKey, 32));
  const header = { schemaVersion: 1 as const, suite: 'liflow-x25519-hkdfsha256-aes256gcm-ed25519-v1' as const,
    groupId, keyVersion, senderDeviceId: sender.deviceId, recipientDeviceId: recipient.deviceId, recipientUserId,
    ephemeralPublicKey: bytesToHex(x25519.getPublicKey(ephemeral)), salt: bytesToHex(salt), nonce: bytesToHex(nonce) };
  const aad = utf8(header); const key = hkdf(sha256, shared, salt, aad, 32);
  try {
    const unsigned = { ...header, encryptedKey: bytesToHex(await crypto.encrypt(key, nonce, groupKey, aad)) };
    return { ...unsigned, signature: signSharedDocument(unsigned, sender) };
  } finally { ephemeral.fill(0); shared.fill(0); key.fill(0); }
}

export async function unwrapGroupKey(
  crypto: SharingCryptoGateway, wrapped: WrappedGroupKey, recipient: DeviceSecretIdentity,
  expectedUserId: string, trustedSender: DevicePublicIdentity, expectedGroupId: string, expectedKeyVersion: number,
): Promise<Uint8Array> {
  validateDeviceSecretIdentity(recipient);
  if (Object.keys(wrapped).sort().join(',') !== 'encryptedKey,ephemeralPublicKey,groupId,keyVersion,nonce,recipientDeviceId,recipientUserId,salt,schemaVersion,senderDeviceId,signature,suite') {
    throw new Error('Unknown wrapped group key field');
  }
  const { signature, encryptedKey, ...header } = wrapped;
  if (header.schemaVersion !== 1 || header.suite !== 'liflow-x25519-hkdfsha256-aes256gcm-ed25519-v1'
    || header.groupId !== expectedGroupId || header.keyVersion !== expectedKeyVersion
    || header.senderDeviceId !== trustedSender.deviceId || header.recipientDeviceId !== recipient.deviceId
    || header.recipientUserId !== expectedUserId) throw new Error('Group key recipient or version mismatch');
  bytes(encryptedKey, 48); positive(header.keyVersion);
  verify({ ...header, encryptedKey }, signature, trustedSender);
  const shared = x25519.getSharedSecret(bytes(recipient.agreementSecretKey, 32), bytes(header.ephemeralPublicKey, 32));
  const aad = utf8(header); const key = hkdf(sha256, shared, bytes(header.salt, 32), aad, 32);
  try {
    const result = await crypto.decrypt(key, bytes(header.nonce, 12), bytes(encryptedKey, 48), aad);
    if (result.length !== 32) throw new Error('Invalid decrypted group key');
    return result;
  } finally { shared.fill(0); key.fill(0); }
}
