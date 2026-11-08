import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest, signSharedDocument, verifySharedDocument } from '../crypto.ts';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import type { VerifiedPrivateCalendarAuthority } from './authority.ts';
import { privateCalendarPairingReference, snapshotPrivateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from './pairing.ts';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from './pairing.ts';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';
import { assertSharedIdentifier } from '../identifier.ts';

export const CONNECTION_CODE_LIFETIME_MS = 10 * 60_000;
const SUITE = 'liflow-private-calendar-connection-v1';
const PREFIX = 'LFS1.';
function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0; for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]; return difference === 0;
}
export interface PrivateCalendarConnectionGrant {
  body: { schemaVersion: 1; suite: typeof SUITE; codeId: string; reference: PrivateCalendarPairingReference;
    issuerDeviceId: string; secretDigest: string; issuedAt: number; expiresAt: number };
  signature: string;
}
export interface PrivateCalendarConnectionCode { grant: PrivateCalendarConnectionGrant; secret: string }
export interface PrivateCalendarConnectionClaim { request: PrivateCalendarPairingRequest; proof: string }
export interface PrivateCalendarConnectionRecord {
  grant: PrivateCalendarConnectionGrant; state: 'open' | 'claimed' | 'complete'; claim: PrivateCalendarConnectionClaim | null;
}
export interface PrivateCalendarConnectionState {
  issued: { code: string; acceptedRequestDigest: string | null } | null;
  joining: { code: string; request: PrivateCalendarPairingRequest } | null;
}
export function snapshotConnectionGrant(value: PrivateCalendarConnectionGrant): PrivateCalendarConnectionGrant {
  exactRecord(value, ['body', 'signature']); const b = value.body;
  exactRecord(b, ['schemaVersion', 'suite', 'codeId', 'reference', 'issuerDeviceId', 'secretDigest', 'issuedAt', 'expiresAt']);
  if (b.schemaVersion !== 1 || b.suite !== SUITE) throw new Error('接続コードの形式が異なります。');
  hexBytes(b.codeId, 32); assertSharedIdentifier(b.issuerDeviceId); hexBytes(b.secretDigest, 32); hexBytes(value.signature, 64);
  positiveInteger(b.issuedAt); positiveInteger(b.expiresAt);
  if (b.expiresAt - b.issuedAt !== CONNECTION_CODE_LIFETIME_MS) throw new Error('接続コードの有効期限が異なります。');
  return { body: { ...b, reference: snapshotPrivateCalendarPairingReference(b.reference) }, signature: value.signature };
}
export function decodeConnectionCode(text: string): PrivateCalendarConnectionCode {
  const input = text.trim();
  if (input.length > 8000 || !input.startsWith(PREFIX) || !/^[A-Za-z0-9_-]+$/.test(input.slice(PREFIX.length))) throw new Error('接続コードを確認してください。');
  const payload = input.slice(PREFIX.length).replaceAll('-', '+').replaceAll('_', '/');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(toByteArray(payload + '='.repeat((4 - payload.length % 4) % 4))));
  exactRecord(raw, ['grant', 'secret']); hexBytes(raw.secret, 32);
  const grant = snapshotConnectionGrant(raw.grant as PrivateCalendarConnectionGrant), secret = raw.secret as string;
  if (!equalBytes(sha256(hexToBytes(secret)), hexToBytes(grant.body.secretDigest))) throw new Error('接続コードを確認してください。');
  return { grant, secret };
}
function encodeConnectionCode(code: PrivateCalendarConnectionCode) {
  return PREFIX + fromByteArray(new TextEncoder().encode(canonicalJson(code))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function createConnectionCode(crypto: SharingCryptoGateway, authority: VerifiedPrivateCalendarAuthority, issuer: DeviceSecretIdentity, now: number) {
  if (!authority.signed.body.devices.some(device => device.deviceId === issuer.deviceId)) throw new Error('この端末から接続コードを発行できません。');
  const secret = await crypto.randomBytes(32), nonce = await crypto.randomBytes(32);
  try {
    if (secret.length !== 32 || nonce.length !== 32) throw new Error('接続コードを発行できませんでした。');
    const body: PrivateCalendarConnectionGrant['body'] = { schemaVersion: 1, suite: SUITE, codeId: bytesToHex(nonce),
      reference: privateCalendarPairingReference(authority), issuerDeviceId: issuer.deviceId, secretDigest: bytesToHex(sha256(secret)),
      issuedAt: now, expiresAt: now + CONNECTION_CODE_LIFETIME_MS };
    return encodeConnectionCode({ grant: snapshotConnectionGrant({ body, signature: signSharedDocument(body, issuer) }), secret: bytesToHex(secret) });
  } finally { secret.fill(0); nonce.fill(0); }
}
export function verifyConnectionGrant(grant: PrivateCalendarConnectionGrant, authority: VerifiedPrivateCalendarAuthority, userId: string, now: number) {
  const owned = snapshotConnectionGrant(grant), b = owned.body, ref = b.reference;
  if (ref.anchor.ownerUserId !== userId || ref.anchor.rootDigest !== authority.anchor.rootDigest
    || ref.anchor.accountGeneration !== authority.anchor.accountGeneration || ref.authorityDigest !== authority.digest
    || ref.authorityRevision !== authority.signed.body.revision || b.expiresAt <= now || b.issuedAt > now + 60_000) throw new Error('接続コードの期限または発行元が変わっています。新しいコードを受け取ってください。');
  const issuer = authority.signed.body.devices.find(device => device.deviceId === b.issuerDeviceId);
  if (!issuer) throw new Error('接続元の端末は解除されています。'); verifySharedDocument(b, owned.signature, issuer);
  return owned;
}
export function connectionClaim(code: PrivateCalendarConnectionCode, request: PrivateCalendarPairingRequest): PrivateCalendarConnectionClaim {
  const owned = verifyPrivateCalendarPairingRequest(request), b = owned.body, ref = code.grant.body.reference;
  if (b.ownerUserId !== ref.anchor.ownerUserId || b.rootDigest !== ref.anchor.rootDigest || b.accountGeneration !== ref.anchor.accountGeneration
    || b.authorityDigest !== ref.authorityDigest || b.authorityRevision !== ref.authorityRevision) throw new Error('接続するアカウントまたは端末設定が異なります。');
  const key = hexToBytes(code.secret);
  try { return { request: owned, proof: bytesToHex(hmac(sha256, key, new TextEncoder().encode(canonicalJson({ codeId: code.grant.body.codeId, request: owned })))) }; }
  finally { key.fill(0); }
}
export function verifyConnectionClaim(code: PrivateCalendarConnectionCode, claim: PrivateCalendarConnectionClaim) {
  exactRecord(claim, ['request', 'proof']); hexBytes(claim.proof, 32);
  const owned = connectionClaim(code, claim.request);
  if (!equalBytes(hexToBytes(owned.proof), hexToBytes(claim.proof))) throw new Error('接続コードの受け取りを確認できません。');
  return owned;
}
export function snapshotConnectionState(state: PrivateCalendarConnectionState, userId: string): PrivateCalendarConnectionState {
  exactRecord(state, ['issued', 'joining']);
  if (state.issued) {
    exactRecord(state.issued, ['code', 'acceptedRequestDigest']); const code = decodeConnectionCode(state.issued.code);
    if (code.grant.body.reference.anchor.ownerUserId !== userId) throw new Error('接続コードの保存アカウントが異なります。');
    if (state.issued.acceptedRequestDigest !== null) hexBytes(state.issued.acceptedRequestDigest, 32);
  }
  if (state.joining) {
    exactRecord(state.joining, ['code', 'request']); const code = decodeConnectionCode(state.joining.code);
    if (code.grant.body.reference.anchor.ownerUserId !== userId) throw new Error('接続コードの保存アカウントが異なります。');
    connectionClaim(code, state.joining.request);
  }
  return JSON.parse(JSON.stringify(state)) as PrivateCalendarConnectionState;
}
export const connectionRequestDigest = (claim: PrivateCalendarConnectionClaim) => sharedDocumentDigest(claim.request);
