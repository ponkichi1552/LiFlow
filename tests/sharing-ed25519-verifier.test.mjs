import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSharedEd25519Verifier } from '../src/features/sharing/ed25519-verifier.ts';
import { readEd25519Fixture } from './helpers/ed25519-fixture.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';

const read = name => readFileSync(new URL(`./fixtures/ed25519-compatibility/${name}`, import.meta.url));
const input = read('conformance.bin');
const metadata = JSON.parse(read('conformance.json'));
const records = readEd25519Fixture(input);

test('libsodium positive results and Noble fallback preserve all public Ed25519 decisions including 169 legacy acceptances', () => {
  assert.equal(createHash('sha256').update(input).digest('hex'), metadata.fixtureSha256);
  assert.equal(records.length, 1112);
  assert.equal(metadata.records, records.length);
  const sodiumAccepted = Buffer.from(metadata.sodiumAcceptedMask, 'hex');
  assert.equal(sodiumAccepted.length, Math.ceil(records.length / 8));
  const baseline = createSharedEd25519Verifier();
  let index = 0; let restored = 0; let nativeAccepted = 0;
  const verify = createSharedEd25519Verifier((signature, message, publicKey) => {
    const reference = records[index];
    assert.equal(signature, reference.signature);
    assert.equal(message, reference.message);
    assert.equal(publicKey, reference.publicKey);
    const accepted = (sodiumAccepted[index >> 3] & (1 << (index & 7))) !== 0;
    nativeAccepted += accepted ? 1 : 0;
    restored += !accepted && reference.expected ? 1 : 0;
    return accepted;
  });
  for (const record of records) {
    assert.equal(baseline(record.signature, record.message, record.publicKey), record.expected, `Noble baseline record ${index}`);
    assert.equal(verify(record.signature, record.message, record.publicKey), record.expected, `hybrid record ${index}`);
    index++;
  }
  assert.equal(nativeAccepted, 181);
  assert.equal(restored, 169);
});

test('native verifier errors fall back to Noble for the session and malformed widths never reach native code', () => {
  const record = records.find(entry => entry.expected);
  assert.ok(record);
  let calls = 0;
  const verifier = createSharedEd25519Verifier(() => { calls++; throw new Error('module unavailable'); });
  assert.throws(() => verifier(record.signature.subarray(1), record.message, record.publicKey));
  assert.throws(() => verifier(record.signature, record.message, record.publicKey.subarray(1)));
  assert.equal(calls, 0);
  assert.equal(verifier(record.signature, record.message, record.publicKey), true);
  assert.equal(verifier(record.signature, record.message, record.publicKey), true);
  assert.equal(calls, 1);
});

test('the app only enables the pinned libsodium version and resolves it lazily once', () => {
  for (const version of [undefined, '1.0.21', '1.0.22']) {
    let loads = 0; let checks = 0; let installed;
    const verify = () => { checks++; return true; };
    loadNativeModule('src/platform/sharing/install-native-ed25519.ts', {
      expo: { requireOptionalNativeModule: name => { assert.equal(name, 'LiFlowEd25519'); loads++; return version && { version, verify }; } },
      '../../features/sharing/ed25519-verifier.ts': { installNativeEd25519Acceptance: accept => { installed = accept; } },
    });
    assert.equal(loads, 0);
    const { signature, message, publicKey } = records[0];
    const enabled = version === '1.0.22';
    assert.equal(installed(signature, message, publicKey), enabled);
    assert.equal(installed(signature, message, publicKey), enabled);
    assert.equal(loads, 1);
    assert.equal(checks, enabled ? 2 : 0);
  }
});
