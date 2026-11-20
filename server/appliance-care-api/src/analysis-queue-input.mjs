import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { publicKey, PublicApiError } from './public-access.mjs';
import { analysisRequestKey } from './analysis-runner.mjs';
import { validateApplianceCareRequest } from './service.mjs';
import { decodeUploadedManual, MAX_MANUAL_BYTES, uploadedManualReference } from './uploaded-manual.mjs';
import { MANUAL_FIELDS, MANUAL_METADATA_LIMIT, MAX_MANUAL_UPLOAD_BYTES, MIN_MANUAL_UPLOAD_BYTES } from './manual-upload-contract.mjs';
import { decryptManualUpload, encryptedManualRequestKey, invalidManualUpload, readManualUploadEnvelope } from './manual-upload-server.mjs';

// Each private Firestore document stays well below its 1 MiB limit. Never put
// tokens, client-supplied URLs or a filesystem path into a worker message.
const CHUNK_BYTES = 480 * 1024;
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = MANUAL_METADATA_LIMIT;
const MAX_LEGACY_INPUT_BYTES = Math.ceil(MAX_MANUAL_BYTES / 3) * 4 + MAX_HEADER_BYTES;
const MAX_BINARY_INPUT_BYTES = MAX_MANUAL_BYTES + HEADER_LENGTH_BYTES + MAX_HEADER_BYTES;
const PRODUCT_FIELDS = MANUAL_FIELDS;
const REQUEST_FIELDS = ['identifyFromManual', ...PRODUCT_FIELDS];
const keyId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const unavailable = () => new PublicApiError(503, 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE', '安全な解析受付の準備ができていません。');

/** Server-only secret configuration; neither a malformed value nor key is logged. */
export function readAnalysisQueueKeys(env = process.env) {
  if (!env.APPLIANCE_CARE_QUEUE_KEYS && !env.APPLIANCE_CARE_QUEUE_ACTIVE_KEY_ID) return undefined;
  try {
    const values = JSON.parse(env.APPLIANCE_CARE_QUEUE_KEYS);
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 4) throw unavailable();
    const keys = new Map(Object.entries(values).map(([id, value]) => {
      if (!keyId(id) || typeof value !== 'string' || value.length !== 44) throw unavailable();
      const bytes = Buffer.from(value, 'base64'); if (bytes.length !== 32 || bytes.toString('base64') !== value) throw unavailable();
      return [id, bytes];
    }));
    return captureAnalysisQueueKeys({ activeKeyId: env.APPLIANCE_CARE_QUEUE_ACTIVE_KEY_ID, keys });
  } catch { throw unavailable(); }
}
export function captureAnalysisQueueKeys(value) {
  if (value === undefined) return undefined;
  if (!keyId(value.activeKeyId) || !(value.keys instanceof Map) || value.keys.size > 4 || !value.keys.has(value.activeKeyId)) throw unavailable();
  const keys = new Map();
  for (const [id, bytes] of value.keys) {
    if (!keyId(id) || !(bytes instanceof Uint8Array) || bytes.length !== 32) throw unavailable();
    keys.set(id, Buffer.from(bytes));
  }
  return { activeKeyId: value.activeKeyId, keys };
}
function aad(manifest, context) {
  if (typeof context.owner !== 'string' || !context.owner || context.owner.length > 128 || !/^[a-f0-9]{64}$/u.test(context.jobId)
    || !/^[a-f0-9]{64}$/u.test(context.requestDigest)) throw new Error('Invalid analysis input context');
  return Buffer.from(JSON.stringify(['liflow-analysis-input-v1', context.owner, context.jobId, context.requestDigest,
    manifest.version, manifest.keyId, manifest.bytes, manifest.sha256, manifest.chunks]), 'utf8');
}
export function prepareAnalysisQueueInput(request, requestKey, keys, context) {
  if (!keys) throw unavailable();
  if (!validateApplianceCareRequest(request) || !Buffer.isBuffer(request.manual?.bytes)
    || request.manual.bytes.length > MAX_MANUAL_BYTES || analysisRequestKey(request) !== requestKey
    || publicKey(requestKey) !== context.requestDigest) throw new Error('Invalid analysis queue input');
  const { bytes: manual, reference } = request.manual;
  if (uploadedManualReference(manual) !== reference) throw new Error('Invalid analysis queue manual identity');
  const identity = { ...(request.identifyFromManual === true ? { identifyFromManual: true } : {}),
    ...Object.fromEntries(PRODUCT_FIELDS.filter(field => typeof request[field] === 'string').map(field => [field, request[field]])) };
  const header = Buffer.from(JSON.stringify(identity), 'utf8');
  if (header.length > MAX_HEADER_BYTES) throw new Error('Analysis input limit');
  const bytes = Buffer.allocUnsafe(HEADER_LENGTH_BYTES + header.length + manual.length);
  bytes.writeUInt32BE(header.length);
  header.copy(bytes, HEADER_LENGTH_BYTES);
  manual.copy(bytes, HEADER_LENGTH_BYTES + header.length);
  const manifest = { version: 2, keyId: keys.activeKeyId, bytes: bytes.length, sha256: publicKey(bytes), chunks: Math.ceil(bytes.length / CHUNK_BYTES) };
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keys.keys.get(keys.activeKeyId), nonce, { authTagLength: 16 });
  cipher.setAAD(aad(manifest, context));
  let encrypted;
  try { encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]); }
  finally { bytes.fill(0); }
  const chunks = [];
  // Binary ciphertext, not a second Base64 envelope. A maximum input plus
  // quota writes fits in one 10 MiB transaction. No key is stored in Firestore.
  for (let offset = 0; offset < encrypted.length; offset += CHUNK_BYTES) chunks.push(Buffer.from(encrypted.subarray(offset, offset + CHUNK_BYTES)));
  return { manifest: { ...manifest, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex') }, chunks };
}

function decodeQueueRequest(bytes, version) {
  if (version === 1) {
    const input = JSON.parse(bytes.toString('utf8'));
    if (!validateApplianceCareRequest(input) || Object.keys(input).some(key => ![...REQUEST_FIELDS, 'manual'].includes(key))) {
      throw new Error('Invalid analysis queue product');
    }
    return { ...input, manual: decodeUploadedManual(input.manual) };
  }
  if (bytes.length <= HEADER_LENGTH_BYTES) throw new Error('Invalid analysis queue header');
  const headerBytes = bytes.readUInt32BE();
  const pdfOffset = HEADER_LENGTH_BYTES + headerBytes;
  if (headerBytes < 2 || headerBytes > MAX_HEADER_BYTES || pdfOffset >= bytes.length) throw new Error('Invalid analysis queue header');
  const input = JSON.parse(bytes.toString('utf8', HEADER_LENGTH_BYTES, pdfOffset));
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !REQUEST_FIELDS.includes(key))) {
    throw new Error('Invalid analysis queue product');
  }
  const manual = bytes.subarray(pdfOffset);
  const request = { ...input, manual: { bytes: manual, reference: uploadedManualReference(manual) } };
  if (!validateApplianceCareRequest(request)) throw new Error('Invalid analysis queue product');
  // The caller clears the decrypted envelope, so the returned PDF needs its own backing storage.
  return { ...request, manual: { ...request.manual, bytes: Buffer.from(manual) } };
}

export function prepareEncryptedAnalysisQueueInput(bytes, requestKey) {
  const envelope = readManualUploadEnvelope(bytes);
  if (envelope.requestKey !== requestKey) throw invalidManualUpload();
  const chunks = [];
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) chunks.push(bytes.subarray(start, start + CHUNK_BYTES));
  return { manifest: { version: 3, keyId: envelope.keyId, bytes: bytes.length, chunks: chunks.length }, chunks };
}

function decodeEncryptedAnalysisQueueInput(manifest, chunks, privateKeys, context) {
  if (!/^[a-f0-9]{64}$/u.test(manifest.keyId) || !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes < MIN_MANUAL_UPLOAD_BYTES || manifest.bytes > MAX_MANUAL_UPLOAD_BYTES
    || manifest.chunks !== Math.ceil(manifest.bytes / CHUNK_BYTES) || chunks.length !== manifest.chunks
    || Object.keys(manifest).sort().join(',') !== 'bytes,chunks,keyId,version') throw new Error('Invalid encrypted manual manifest');
  chunks.forEach((chunk, index) => {
    if (!(chunk instanceof Uint8Array) || chunk.length !== Math.min(CHUNK_BYTES, manifest.bytes - index * CHUNK_BYTES)) {
      throw new Error('Invalid encrypted manual chunk');
    }
  });
  const plaintext = decryptManualUpload(Buffer.concat(chunks, manifest.bytes), manifest.keyId, privateKeys, context);
  let request;
  try {
    request = decodeQueueRequest(plaintext, 2);
    if (publicKey(encryptedManualRequestKey(context.owner, request)) !== context.requestDigest) throw invalidManualUpload();
    return request;
  } catch {
    request?.manual?.bytes.fill(0);
    throw invalidManualUpload();
  } finally { plaintext.fill(0); }
}

export function decodeAnalysisQueueInput(manifest, chunks, keys, context, privateKeys) {
  const version = manifest?.version;
  if (version === 3) return decodeEncryptedAnalysisQueueInput(manifest, chunks, privateKeys, context);
  const maxInputBytes = version === 2 ? MAX_BINARY_INPUT_BYTES : MAX_LEGACY_INPUT_BYTES;
  if ((version !== 1 && version !== 2) || !keyId(manifest.keyId) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > maxInputBytes
    || !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > Math.ceil(maxInputBytes / CHUNK_BYTES)
    || !/^[a-f0-9]{64}$/u.test(manifest.sha256) || !/^[a-f0-9]{24}$/u.test(manifest.nonce) || !/^[a-f0-9]{32}$/u.test(manifest.tag)
    || chunks.length !== manifest.chunks || Object.keys(manifest).sort().join(',') !== 'bytes,chunks,keyId,nonce,sha256,tag,version') throw new Error('Invalid analysis queue manifest');
  const key = keys?.keys.get(manifest.keyId); if (!key) throw unavailable();
  const parts = chunks.map((chunk, i) => {
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid analysis input chunk');
    const bytes = Buffer.from(chunk);
    if (bytes.length !== Math.min(CHUNK_BYTES, manifest.bytes - i * CHUNK_BYTES)) throw new Error('Invalid analysis input chunk size');
    return bytes;
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.nonce, 'hex'), { authTagLength: 16 });
  decipher.setAAD(aad(manifest, context)); decipher.setAuthTag(Buffer.from(manifest.tag, 'hex'));
  let bytes;
  try {
    const partial = decipher.update(Buffer.concat(parts));
    try { bytes = Buffer.concat([partial, decipher.final()]); } finally { partial.fill(0); }
    if (bytes.length !== manifest.bytes || publicKey(bytes) !== manifest.sha256) throw new Error('Corrupt analysis queue input');
    const request = decodeQueueRequest(bytes, version);
    if (publicKey(analysisRequestKey(request)) !== context.requestDigest) throw new Error('Analysis queue identity mismatch');
    return request;
  } finally { bytes?.fill(0); }
}
