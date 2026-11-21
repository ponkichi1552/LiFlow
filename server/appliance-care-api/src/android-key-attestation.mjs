import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Boolean as AsnBoolean, Enumerated, Integer, OctetString, Sequence, Set as AsnSet, fromBER } from 'asn1js';
import { Certificate, CertificateChainValidationEngine } from 'pkijs';
import { deviceProofRequired, deviceProofTemporary } from './native-device-authorization.mjs';

export const ANDROID_APPLIANCE_PACKAGE = 'jp.jphacks.tkb2633';
const KEY_ATTESTATION = '1.3.6.1.4.1.11129.2.1.17';
const PROVISIONING_INFO = '1.3.6.1.4.1.11129.2.1.30';
const SUBJECT_SERIAL_NUMBER = '2.5.4.5';
const FACTORY_ROOT_SUBJECT_SERIAL = 'f92009e853b6b045';
const STATUS_URL = 'https://android.googleapis.com/attestation/status';
const googleRoots = JSON.parse(readFileSync(new URL('./android-hardware-attestation-roots.json', import.meta.url), 'utf8'));
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86400_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const serialPattern = /^[a-f0-9]{1,40}$/iu;
const serialHash = value => sha256(value.toLowerCase().replace(/^0+(?=.)/u, ''));

function requireProof(valid) {
  if (!valid) throw deviceProofRequired();
}

function parseAsn(bytes, Type) {
  const { result, offset } = fromBER(bytes);
  requireProof(offset === bytes.byteLength && result instanceof Type);
  return result.valueBlock.value;
}

function numeric(value, Type = Integer) {
  requireProof(value instanceof Type && value.valueBlock.valueHexView.length <= 4);
  return value.valueBlock.valueDec;
}

function octets(value) {
  requireProof(value instanceof OctetString && !value.idBlock.isConstructed);
  return Buffer.from(value.valueBlock.valueHexView);
}

function authorizations(sequence) {
  requireProof(sequence instanceof Sequence);
  const tags = new Map();
  for (const entry of sequence.valueBlock.value) {
    const { tagClass, tagNumber, isConstructed } = entry.idBlock;
    const values = entry.valueBlock.value;
    requireProof(tagClass === 3 && isConstructed && values.length === 1 && !tags.has(tagNumber));
    tags.set(tagNumber, values[0]);
  }
  return tags;
}

function requireSet(value, expected) {
  requireProof(value instanceof AsnSet && value.valueBlock.value.length === 1 && numeric(value.valueBlock.value[0]) === expected);
}

function verifyAppId(appId, signingDigests) {
  const [packages, digests, extra] = parseAsn(octets(appId), Sequence);
  requireProof(!extra && packages instanceof AsnSet && packages.valueBlock.value.length === 1 && digests instanceof AsnSet);
  const packageInfo = packages.valueBlock.value[0];
  requireProof(packageInfo instanceof Sequence && packageInfo.valueBlock.value.length === 2);
  const [name, version] = packageInfo.valueBlock.value;
  requireProof(octets(name).equals(Buffer.from(ANDROID_APPLIANCE_PACKAGE)) && version instanceof Integer);
  const values = digests.valueBlock.value.map(digest => octets(digest).toString('hex'));
  requireProof(values.length > 0 && values.every(digest => signingDigests.has(digest)));
  return values;
}

function verifyKeyDescription(extension, challenge, signingDigests) {
  const fields = parseAsn(extension.extnValue.valueBlock.valueHexView, Sequence);
  requireProof(fields.length === 8);
  const [attestationVersion, attestationSecurity, keyVersion, keySecurity, nonce, , softwareEnforced, hardwareEnforced] = fields;
  requireProof(numeric(attestationVersion) > 0 && numeric(keyVersion) > 0 && [1, 2].includes(numeric(attestationSecurity, Enumerated))
    && [1, 2].includes(numeric(keySecurity, Enumerated)) && sha256(challenge) === octets(nonce).toString('hex'));
  const software = authorizations(softwareEnforced);
  const hardware = authorizations(hardwareEnforced);
  requireSet(hardware.get(1), 2); // SIGN
  const digests = hardware.get(5) ?? software.get(5);
  if (digests) requireSet(digests, 4); // The challenge signature itself is always verified with SHA-256.
  requireProof(numeric(hardware.get(2)) === 3 && numeric(hardware.get(3)) === 256 && numeric(hardware.get(10)) === 1
    && numeric(hardware.get(702)) === 0); // EC P-256, generated in secure hardware
  const trust = hardware.get(704);
  requireProof(trust instanceof Sequence && [3, 4].includes(trust.valueBlock.value.length));
  const [bootKey, locked, bootState] = trust.valueBlock.value;
  requireProof(octets(bootKey).length > 0 && locked instanceof AsnBoolean && locked.valueBlock.value && numeric(bootState, Enumerated) === 0);
  requireProof(software.has(709) !== hardware.has(709));
  return verifyAppId(software.get(709) ?? hardware.get(709), signingDigests);
}

function extensionOn(path, oid) {
  // Use the extension closest to the trusted root, which cannot be appended by the caller.
  for (let index = path.length - 1; index >= 0; index--) {
    const matches = path[index].extensions?.filter(extension => extension.extnID === oid) ?? [];
    requireProof(matches.length <= 1);
    if (matches.length) return { index, extension: matches[0] };
  }
  return undefined;
}

function subjectSerial(cert) {
  return cert.subject.typesAndValues.find(entry => entry.type === SUBJECT_SERIAL_NUMBER)?.value.valueBlock.value;
}

function readTrustedPath(path, trusted) {
  const tail = path.at(-1);
  const root = trusted.find(cert => cert.raw.equals(tail.raw) || (tail.issuer === cert.subject && tail.verify(cert.publicKey)));
  requireProof(root);
  const tailIsAnchor = tail.subject === root.subject
    && tail.publicKey.export({ type: 'spki', format: 'der' }).equals(root.publicKey.export({ type: 'spki', format: 'der' }));
  // Older factory devices include an older encoding of the very same Google root key.
  return tailIsAnchor ? [...path.slice(0, -1), root] : [...path, root];
}

async function verifyCertificatePath(path, parsed, at, provisioning) {
  const root = parsed.at(-1);
  const factoryProvisioned = !provisioning && path.length === 4
    && subjectSerial(root) === FACTORY_ROOT_SUBJECT_SERIAL && typeof subjectSerial(parsed.at(-2)) === 'string';
  requireProof(path.every(cert => cert.validFromDate.getTime() <= at));
  if (factoryProvisioned) {
    // Google factory-provisioned chains can have expired issuers and a non-CA
    // attestation signer. Still verify each link and use only the trusted leaf extension.
    requireProof(path[2].ca && path.every((cert, index) => index === 0
      || path[index - 1].issuer === cert.subject && path[index - 1].verify(cert.publicKey)));
    return Math.min(path[0].validToDate.getTime(), path.at(-1).validToDate.getTime());
  }
  requireProof(path.every((cert, index) => index === 0 || cert.ca && path[index - 1].checkIssued(cert)));
  const engine = new CertificateChainValidationEngine({ trustedCerts: [root], certs: parsed.slice(0, -1).reverse(), checkDate: new Date(at) });
  // Revocation is checked separately against Google's Android-wide status list.
  const result = await engine.verify({ passedWhenNotRevValues: true });
  requireProof(result.result && result.certificatePath.length === parsed.length
    && result.certificatePath.every((cert, index) => Buffer.from(cert.tbsView).equals(parsed[index].tbsView)));
  return Math.min(...path.map(cert => cert.validToDate.getTime()));
}

async function readStatusList(response) {
  if (Number(response.headers.get('content-length')) > MAX_STATUS_BYTES || !response.body) throw deviceProofTemporary();
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_STATUS_BYTES) throw deviceProofTemporary();
    chunks.push(chunk);
  }
  const { entries } = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw deviceProofTemporary();
  const rejected = new Set();
  for (const [serial, entry] of Object.entries(entries)) {
    if (!serialPattern.test(serial) || !['REVOKED', 'SUSPENDED'].includes(entry?.status)) throw deviceProofTemporary();
    rejected.add(serialHash(serial));
  }
  return rejected;
}

function createRevocationCheck(fetcher, now) {
  let cached;
  let pending;
  let retryAt = 0;
  async function refresh() {
    try {
      const response = await fetcher(STATUS_URL, { signal: AbortSignal.timeout(5500), redirect: 'error' });
      const maxAge = Number(response.headers.get('cache-control')?.match(/(?:^|,)\s*max-age=(\d+)/iu)?.[1]);
      const age = Number(response.headers.get('age') ?? 0);
      const freshFor = Math.min(DAY_MS, (maxAge - age) * 1000);
      if (!response.ok || !Number.isFinite(freshFor) || freshFor <= 0 || age < 0) {
        await response.body?.cancel();
        throw deviceProofTemporary();
      }
      const expiresAt = now() + freshFor;
      const rejected = await readStatusList(response);
      if (now() >= expiresAt) throw deviceProofTemporary();
      cached = { rejected, expiresAt };
      return rejected;
    } catch {
      retryAt = now() + 15_000;
      throw deviceProofTemporary(retryAt);
    }
  }
  return async serials => {
    if (retryAt > now()) throw deviceProofTemporary(retryAt);
    const rejected = cached?.expiresAt > now() ? cached.rejected : await (pending ??= refresh().finally(() => { pending = undefined; }));
    return serials.every(serial => !rejected.has(serial));
  };
}

export function createAndroidKeyAttestation({ signingDigests, roots = googleRoots, fetcher = fetch, now = Date.now }) {
  const trusted = roots.map(pem => new X509Certificate(pem));
  const unrevoked = createRevocationCheck(fetcher, now);
  return {
    async verify(chain, challenge) {
      let record;
      try {
        requireProof(Array.isArray(chain) && chain.length >= 2 && chain.length <= 8);
        let size = 0;
        const supplied = chain.map(base64 => {
          requireProof(typeof base64 === 'string' && (size += base64.length) <= 20 * 1024);
          const der = Buffer.from(base64, 'base64');
          requireProof(der.toString('base64') === base64);
          const cert = new X509Certificate(der);
          requireProof(der.equals(cert.raw) && serialPattern.test(cert.serialNumber));
          return cert;
        });
        const path = readTrustedPath(supplied, trusted);
        requireProof(path.length <= 8 && new Set(path.map(cert => cert.fingerprint256)).size === path.length);
        const [leaf] = path;
        requireProof(!leaf.ca && leaf.publicKey.asymmetricKeyType === 'ec' && leaf.publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1');
        const parsed = path.map(cert => Certificate.fromBER(cert.raw));
        const attestation = extensionOn(parsed, KEY_ATTESTATION);
        const provisioning = extensionOn(parsed, PROVISIONING_INFO);
        requireProof(attestation?.index === 0 && (!provisioning || provisioning.index === 1));
        const at = now();
        const validUntil = Math.min(at + 90 * DAY_MS, await verifyCertificatePath(path, parsed, at, provisioning));
        requireProof(validUntil > at);
        const attestedDigests = verifyKeyDescription(attestation.extension, challenge, signingDigests);
        const publicKey = leaf.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        const serials = [...new Set([...supplied, path.at(-1)].map(cert => serialHash(cert.serialNumber)))];
        record = { keyDigest: sha256(publicKey), publicKey, attestedDigests, validUntil, serials };
      } catch {
        throw deviceProofRequired();
      }
      requireProof(await unrevoked(record.serials));
      return record;
    },
    accepts(record, keyDigest) {
      return record?.keyDigest === keyDigest && record.validUntil > now() && record.attestedDigests?.length > 0
        && record.attestedDigests.every(digest => signingDigests.has(digest)) && record.serials?.length >= 2 ? unrevoked(record.serials) : false;
    },
  };
}
