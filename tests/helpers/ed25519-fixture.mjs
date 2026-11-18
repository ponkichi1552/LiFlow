const magic = [76, 70, 69, 68, 86, 48, 48, 49]; // LFEDV001

/** Public compatibility corpus or a local QA snapshot of already-signed statements. */
export function readEd25519Fixture(bytes) {
  if (bytes.length < 12 || magic.some((byte, index) => bytes[index] !== byte)) throw new Error('Invalid Ed25519 fixture header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  if (count > Math.floor((bytes.length - 12) / 101)) throw new Error('Invalid Ed25519 fixture count');
  let offset = 12;
  const records = [];
  for (let index = 0; index < count; index++) {
    if (bytes.length - offset < 101 || bytes[offset] > 1) throw new Error('Invalid Ed25519 record header');
    const length = view.getUint32(offset + 97, true);
    const end = offset + 101 + length;
    if (end > bytes.length) throw new Error('Truncated Ed25519 record');
    records.push({ expected: bytes[offset] === 1, publicKey: bytes.subarray(offset + 1, offset + 33),
      signature: bytes.subarray(offset + 33, offset + 97), message: bytes.subarray(offset + 101, end) });
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('Unexpected Ed25519 fixture suffix');
  return records;
}
