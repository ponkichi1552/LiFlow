import { x25519 } from '@noble/curves/ed25519.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { MANUAL_FIELDS, MANUAL_HEADER_BYTES, MANUAL_METADATA_LIMIT, MANUAL_TAG_BYTES, manualHpkeInfo, manualUploadAad,
  manualUploadIdentity } from '../../../server/appliance-care-api/src/manual-upload-contract.mjs';
import { deriveManualAead, deriveManualKemSecret } from '../../../server/appliance-care-api/src/manual-hpke.mjs';
import { nativeSharingCrypto } from '../../platform/sharing/native-crypto';
import { verifyManualContent } from './manual-document';
import type { ApplianceCareApiRequest, UploadedManualInput } from './api-contracts';

const kdf = {
  extract: (salt: Uint8Array, input: Uint8Array) => extract(sha256, input, salt),
  expand: (key: Uint8Array, info: Uint8Array, length: number) => expand(sha256, key, info, length),
};

export async function encryptManualUpload(request: ApplianceCareApiRequest & { manual: UploadedManualInput }, owner: string, admission: string) {
  const configuredKey = process.env.EXPO_PUBLIC_APPLIANCE_CARE_UPLOAD_KEY?.trim();
  if (!configuredKey || !/^[a-f0-9]{64}$/u.test(configuredKey)) {
    throw Object.assign(new Error('家電AIの暗号化設定を確認できません。'), { code: 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE' });
  }
  if (!owner || !/^[a-zA-Z0-9_-]{16,100}$/u.test(admission) || request.manual.rightsConfirmed !== true) {
    throw Object.assign(new Error('PDFの受付を確認できません。'), { code: 'INVALID_MANUAL' });
  }
  const recipient = hexToBytes(configuredKey);
  const identity = { ...(request.identifyFromManual === true ? { identifyFromManual: true } : {}),
    ...Object.fromEntries(MANUAL_FIELDS.flatMap(field => typeof request[field] === 'string' ? [[field, request[field]]] : [])) };
  const metadata = utf8ToBytes(JSON.stringify(identity));
  if (metadata.length > MANUAL_METADATA_LIMIT) throw Object.assign(new Error('製品の入力内容が長すぎます。'), { code: 'INVALID_REQUEST' });
  let manual: ReturnType<typeof verifyManualContent>;
  try { manual = verifyManualContent(request.manual.base64); }
  catch { throw Object.assign(new Error('取扱説明書PDFを確認してください（6MiB以内）。'), { code: 'INVALID_MANUAL' }); }

  const plaintext = new Uint8Array(4 + metadata.length + manual.byteLength);
  new DataView(plaintext.buffer).setUint32(0, metadata.length);
  plaintext.set(metadata, 4);
  plaintext.set(manual.bytes, 4 + metadata.length);
  manual.bytes.fill(0);
  let ephemeral: Uint8Array | undefined;
  let dh: Uint8Array | undefined;
  let secret: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    ephemeral = await nativeSharingCrypto.randomBytes(32);
    const enc = x25519.getPublicKey(ephemeral);
    dh = x25519.getSharedSecret(ephemeral, recipient);
    secret = deriveManualKemSecret(dh, enc, recipient, kdf);
    const aead = deriveManualAead(secret, manualHpkeInfo(), kdf);
    key = aead.key;

    const body = new Uint8Array(MANUAL_HEADER_BYTES + plaintext.length + MANUAL_TAG_BYTES);
    body.set(sha256(recipient), 0);
    body.set(enc, 32);
    body.set(sha256(utf8ToBytes(manualUploadIdentity(owner, { ...identity, manual: { reference: `liflow-manual://sha256/${manual.sha256}` } }))), 64);
    body[96] = request.forceReanalysis === true ? 1 : 0;
    const jobId = bytesToHex(sha256(utf8ToBytes(JSON.stringify([owner, admission]))));
    const ciphertext = await nativeSharingCrypto.encrypt(key, aead.nonce, plaintext, manualUploadAad(jobId, body.subarray(0, MANUAL_HEADER_BYTES)));
    if (ciphertext.length !== plaintext.length + MANUAL_TAG_BYTES) throw new Error('Invalid native ciphertext length');
    body.set(ciphertext, MANUAL_HEADER_BYTES);
    return body.buffer;
  } finally {
    plaintext.fill(0);
    ephemeral?.fill(0);
    dh?.fill(0);
    secret?.fill(0);
    key?.fill(0);
  }
}
