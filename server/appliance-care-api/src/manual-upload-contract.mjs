export const MANUAL_UPLOAD_CONTENT_TYPE = 'application/vnd.liflow.manual-v1+octet-stream';
export const MAX_MANUAL_BYTES = 6 * 1024 * 1024;
export const MANUAL_FIELDS = Object.freeze(['manufacturer', 'productName', 'modelNumber', 'category']);
export const MAX_UPLOADED_MODELS = 20;
// The envelope holds all verified model numbers plus the other identity fields in UTF-8.
export const MANUAL_METADATA_LIMIT = 12 * 1024;
// Three 32-byte fields (recipient key ID, encapsulated key, request digest) followed by one flags byte.
export const MANUAL_HEADER_BYTES = 97;
export const MANUAL_TAG_BYTES = 16;
export const MAX_MANUAL_UPLOAD_BYTES = MANUAL_HEADER_BYTES + 4 + MANUAL_METADATA_LIMIT + MAX_MANUAL_BYTES + MANUAL_TAG_BYTES;
export const MIN_MANUAL_UPLOAD_BYTES = MANUAL_HEADER_BYTES + 4 + 2 + 32 + MANUAL_TAG_BYTES;

const utf8 = new TextEncoder();
export const manualHpkeInfo = () => utf8.encode('LiFlow appliance manual upload v1');

export function isManualIdentityText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isManualModelList(value) {
  if (typeof value !== 'string') return false;
  const models = value.trim().split(' / ', MAX_UPLOADED_MODELS + 1);
  return models.length <= MAX_UPLOADED_MODELS && models.every(isManualIdentityText);
}

export function manualUploadAad(jobId, header) {
  const context = utf8.encode(jobId);
  const aad = new Uint8Array(context.length + header.length);
  aad.set(context);
  aad.set(header, context.length);
  return aad;
}

export function analysisRequestKey(request) {
  return JSON.stringify([...(request.identifyFromManual === true ? ['uploaded-product-v1'] : []), request.manual?.reference ?? 'official-manual-v1',
    ...MANUAL_FIELDS.map(field => (request[field] ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))]);
}

export function manualUploadIdentity(owner, request) {
  return JSON.stringify(['liflow-manual-upload-v1', owner, analysisRequestKey(request)]);
}
