import { createDecipheriv, createHmac, createPrivateKey, createPublicKey, decapsulate } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { MANUAL_HEADER_BYTES, MANUAL_TAG_BYTES, MAX_MANUAL_UPLOAD_BYTES, MIN_MANUAL_UPLOAD_BYTES, manualHpkeInfo,
  manualUploadAad, manualUploadIdentity } from './manual-upload-contract.mjs';
import { deriveManualAead } from './manual-hpke.mjs';
import { PublicApiError, publicKey } from './public-access.mjs';

const hex = /^[a-f0-9]{64}$/u;
const nodeKdf = {
  extract: (salt, input) => createHmac('sha256', salt).update(input).digest(),
  expand: (key, info, length) => createHmac('sha256', key).update(info).update('\x01').digest().subarray(0, length),
};
export const invalidManualUpload = () => new PublicApiError(400, 'INVALID_MANUAL', '説明書PDFを確認できませんでした。もう一度選んでください。');
export const unavailableManualUpload = () => new PublicApiError(503, 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE', '安全な解析受付の準備ができていません。');
export const manualPreflightErrorCodes = Object.freeze(['INVALID_MANUAL', 'TEMPORARY_NETWORK_ERROR', 'RATE_LIMITED']);

export function readManualUploadKeyIds(env = process.env) {
  const configured = env.APPLIANCE_CARE_UPLOAD_KEY_IDS?.trim();
  const ids = configured ? configured.split(',').map(value => value.trim()) : [];
  if (ids.length > 4 || ids.some(value => !hex.test(value)) || new Set(ids).size !== ids.length) throw unavailableManualUpload();
  return Object.freeze(ids);
}

export function readManualUploadPrivateKeys(env = process.env) {
  if (!env.APPLIANCE_CARE_UPLOAD_PRIVATE_KEYS) return undefined;
  try {
    const entries = JSON.parse(env.APPLIANCE_CARE_UPLOAD_PRIVATE_KEYS);
    if (!Array.isArray(entries) || !entries.length || entries.length > 4) throw unavailableManualUpload();
    const keys = new Map();
    for (const entry of entries) {
      if (typeof entry !== 'string' || !hex.test(entry) || /^0+$/u.test(entry)) throw unavailableManualUpload();
      const secret = Buffer.from(entry, 'hex');
      try {
        const key = createPrivateKey({ key: secret, format: 'raw-private', asymmetricKeyType: 'x25519' });
        const id = publicKey(createPublicKey(key).export({ format: 'raw-public' }));
        if (keys.has(id)) throw unavailableManualUpload();
        keys.set(id, key);
      } finally { secret.fill(0); }
    }
    return keys;
  } catch { throw unavailableManualUpload(); }
}

export function readManualUploadEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_MANUAL_UPLOAD_BYTES || bytes.length > MAX_MANUAL_UPLOAD_BYTES || bytes[96] > 1) {
    throw invalidManualUpload();
  }
  return { keyId: bytes.toString('hex', 0, 32), requestKey: 'encrypted-manual-v1:' + bytes.toString('hex', 64, 96), forceReanalysis: bytes[96] === 1 };
}

export function encryptedManualRequestKey(owner, request) {
  return 'encrypted-manual-v1:' + publicKey(manualUploadIdentity(owner, request));
}

export function decryptManualUpload(bytes, keyId, privateKeys, context) {
  const envelope = readManualUploadEnvelope(bytes);
  if (envelope.keyId !== keyId || publicKey(envelope.requestKey) !== context.requestDigest) throw invalidManualUpload();
  const recipient = privateKeys?.get(keyId);
  if (!recipient) throw unavailableManualUpload();
  let secret;
  let key;
  let plaintext;
  try {
    secret = decapsulate(recipient, bytes.subarray(32, 64));
    const aead = deriveManualAead(secret, manualHpkeInfo(), nodeKdf);
    key = aead.key;
    const decipher = createDecipheriv('aes-256-gcm', key, aead.nonce, { authTagLength: MANUAL_TAG_BYTES });
    decipher.setAAD(manualUploadAad(context.jobId, bytes.subarray(0, MANUAL_HEADER_BYTES)));
    decipher.setAuthTag(bytes.subarray(-MANUAL_TAG_BYTES));
    plaintext = decipher.update(bytes.subarray(MANUAL_HEADER_BYTES, -MANUAL_TAG_BYTES));
    decipher.final();
    return plaintext;
  } catch {
    plaintext?.fill(0);
    throw invalidManualUpload();
  } finally {
    secret?.fill(0);
    key?.fill(0);
  }
}
