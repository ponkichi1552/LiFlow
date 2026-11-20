// RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
// The app uses its native AEAD, and the worker uses OpenSSL for DHKEM and AEAD.
const utf8 = new TextEncoder();
const version = utf8.encode('HPKE-v1');
const kemSuite = Uint8Array.of(0x4b, 0x45, 0x4d, 0x00, 0x20);
const suite = Uint8Array.of(0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x02);
const empty = new Uint8Array();

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function labeledExtract(kdf, id, salt, label, bytes) {
  const input = concat(version, id, utf8.encode(label), bytes);
  try { return kdf.extract(salt, input); }
  finally { input.fill(0); }
}

function labeledExpand(kdf, id, prk, label, info, length) {
  return kdf.expand(prk, concat(Uint8Array.of(0, length), version, id, utf8.encode(label), info), length);
}

export function deriveManualKemSecret(dh, ephemeralPublic, recipientPublic, kdf) {
  const eaePrk = labeledExtract(kdf, kemSuite, empty, 'eae_prk', dh);
  try { return labeledExpand(kdf, kemSuite, eaePrk, 'shared_secret', concat(ephemeralPublic, recipientPublic), 32); }
  finally { eaePrk.fill(0); }
}

export function deriveManualAead(sharedSecret, info, kdf) {
  const pskIdHash = labeledExtract(kdf, suite, empty, 'psk_id_hash', empty);
  const infoHash = labeledExtract(kdf, suite, empty, 'info_hash', info);
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(kdf, suite, sharedSecret, 'secret', empty);
  try {
    const nonce = labeledExpand(kdf, suite, secret, 'base_nonce', context, 12);
    const key = labeledExpand(kdf, suite, secret, 'key', context, 32);
    return { key, nonce }; // one ciphertext per fresh KEM context, sequence number zero
  } finally { secret.fill(0); }
}
