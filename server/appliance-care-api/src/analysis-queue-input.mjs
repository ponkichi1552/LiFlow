import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { publicKey, PublicApiError } from './public-access.mjs';
import { analysisRequestKey } from './analysis-runner.mjs';
import { validateApplianceCareRequest } from './service.mjs';
import { decodeUploadedManual, MAX_MANUAL_BYTES } from './uploaded-manual.mjs';

// Each private Firestore document stays well below its 1 MiB limit. Never put
// tokens, client-supplied URLs or a filesystem path into a worker message.
const CHUNK_BYTES = 480 * 1024;
const MAX_INPUT_BYTES = Math.ceil(MAX_MANUAL_BYTES / 3) * 4 + 4096;
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
  const input = { manufacturer: request.manufacturer, productName: request.productName, modelNumber: request.modelNumber,
    ...(typeof request.category === 'string' ? { category: request.category } : {}),
    manual: { rightsConfirmed: true, base64: request.manual.bytes.toString('base64') } };
  // Check the same canonical PDF envelope again without parsing it on the HTTP thread.
  const decoded = decodeUploadedManual(input.manual);
  if (decoded.reference !== request.manual.reference) throw new Error('Invalid analysis queue manual identity');
  const bytes = Buffer.from(JSON.stringify(input), 'utf8'); if (bytes.length > MAX_INPUT_BYTES) throw new Error('Analysis input limit');
  const manifest = { version: 1, keyId: keys.activeKeyId, bytes: bytes.length, sha256: publicKey(bytes), chunks: Math.ceil(bytes.length / CHUNK_BYTES) };
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keys.keys.get(keys.activeKeyId), nonce, { authTagLength: 16 });
  cipher.setAAD(aad(manifest, context));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]); bytes.fill(0);
  const chunks = [];
  // Binary ciphertext, not a second Base64 envelope. A maximum input plus
  // quota writes fits in one 10 MiB transaction. No key is stored in Firestore.
  for (let offset = 0; offset < encrypted.length; offset += CHUNK_BYTES) chunks.push(Buffer.from(encrypted.subarray(offset, offset + CHUNK_BYTES)));
  return { manifest: { ...manifest, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex') }, chunks };
}

export function decodeAnalysisQueueInput(manifest, chunks, keys, context) {
  if (manifest?.version !== 1 || !keyId(manifest.keyId) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_INPUT_BYTES
    || !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > Math.ceil(MAX_INPUT_BYTES / CHUNK_BYTES)
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
    const input = JSON.parse(bytes.toString('utf8'));
    if (!validateApplianceCareRequest(input) || Object.keys(input).some(key => !['manufacturer', 'productName', 'modelNumber', 'category', 'manual'].includes(key))) throw new Error('Invalid analysis queue product');
    const request = { ...input, manual: decodeUploadedManual(input.manual) };
    if (publicKey(analysisRequestKey(request)) !== context.requestDigest) throw new Error('Analysis queue identity mismatch');
    return request;
  } finally { bytes?.fill(0); }
}
