import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, verify } from 'node:crypto';
import { dirname, join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const certificates = cliRequire('@expo/code-signing-certificates');
const certificateRequire = createRequire(cliRequire.resolve('@expo/code-signing-certificates/package.json'));
const forge = cliRequire('node-forge');
const z = cliRequire('zod').z;
const cliRoot = dirname(expoRequire.resolve('@expo/cli/package.json'));
const { PluginSchema, DevToolsPluginOutputSchema } = require(join(cliRoot, 'build/src/start/server/devtools/DevToolsPlugin.schema.js'));
const { validate: validateCliSchema } = cliRequire('@expo/schema-utils');
const { createMCPDevToolsExtensionSchema } = require(join(cliRoot, 'build/src/start/server/mcp/createMCPDevToolsExtensionSchema.js'));

// Ephemeral test keys only; no signing credentials are read from the host.
const pem = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const keyPair = certificates.convertKeyPairPEMToKeyPair({ privateKeyPEM: pem.privateKey, publicKeyPEM: pem.publicKey });
const digest = forge.md.sha256.create().update('LiFlow dependency security regression').digest().getBytes();
const { asn1 } = forge;
const node = (type, constructed, value) => asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
const oid = () => node(asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes());
const nil = () => node(asn1.Type.NULL, false, '');
function digestSignature(children) {
  const info = node(asn1.Type.SEQUENCE, true, [node(asn1.Type.SEQUENCE, true, children), node(asn1.Type.OCTETSTRING, false, digest)]);
  return keyPair.privateKey.sign(asn1.toDer(info).getBytes(), 'NONE');
}

test('security override resolves patched Zod for the CLI and React Hooks without leaving a vulnerable second copy', () => {
  const hookRequire = createRequire(require.resolve('eslint-plugin-react-hooks'));
  const errorRequire = createRequire(hookRequire.resolve('zod-validation-error'));
  for (const consumer of [cliRequire, hookRequire, errorRequire]) {
    assert.equal(consumer('zod/package.json').version, '4.6.7');
    assert.equal(consumer.resolve('zod/package.json'), cliRequire.resolve('zod/package.json'));
  }
});

test('patched Zod rejects oversized bounded arrays, sets and maps before validating elements in sync and async paths', async () => {
  for (const mode of ['sync', 'async']) {
    let elements = 0;
    const element = z.string().refine(() => { elements++; return false; });
    for (const [schema, input] of [
      [z.array(element).max(2), ['a', 'b', 'c']],
      [z.array(element).length(2), ['a', 'b', 'c']],
      [z.set(element).max(2), new Set(['a', 'b', 'c'])],
      [z.map(element, element).max(2), new Map([['a', 'a'], ['b', 'b'], ['c', 'c']])],
    ]) {
      const result = mode === 'async' ? await schema.safeParseAsync(input) : schema.safeParse(input);
      assert.equal(result.success, false);
      assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big');
    }
    assert.equal(elements, 0, 'upper bounds must run before per-element work');
  }
});

const plugin = { packageName: 'liflow-test-plugin', packageRoot: '/test/plugin', bannerTitle: false,
  cliExtensions: { description: 'test tools', entryPoint: 'cli.js', commands: [{ name: 'inspect', title: 'Inspect',
    environments: ['cli', 'mcp'], parameters: [{ name: 'text', type: 'text' }, { name: 'count', type: 'number' }, { name: 'enabled', type: 'confirm' }] }] } };

test('Expo SDK 58 plugin and CLI output schemas preserve valid data and reject invalid data with the current validator', () => {
  // SDK 58.0.22 moved these internal schemas from Zod to schema-utils JSON Schema.
  // Exercise the installed validator used by the CLI instead of recreating its old API.
  const input = { ...plugin, ignored: 'retained by the current JSON Schema' }; const before = JSON.stringify(input);
  assert.doesNotThrow(() => validateCliSchema(PluginSchema, input)); assert.equal(JSON.stringify(input), before);
  assert.throws(() => validateCliSchema(PluginSchema, { ...plugin, packageName: '' }));
  assert.throws(() => validateCliSchema(PluginSchema, { ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } }));
  const output = [{ type: 'text', text: 'ready', level: 'info' }, { type: 'image', url: 'https://example.com/test.png' }, { type: 'audio', url: 'https://example.com/test.wav' }];
  assert.doesNotThrow(() => validateCliSchema(DevToolsPluginOutputSchema, output));
  assert.throws(() => validateCliSchema(DevToolsPluginOutputSchema, [{ type: 'text', text: 'invalid', level: 'invalid' }]));
  assert.throws(() => validateCliSchema(DevToolsPluginOutputSchema, [{ type: 'image', url: 'invalid' }]));
});

test('Expo SDK 58 MCP command schemas keep typed arguments, strict unknown-key rejection and JSON Schema conversion', () => {
  const schema = createMCPDevToolsExtensionSchema(plugin, z);
  const parameters = { command: 'inspect', text: 'test', count: 2, enabled: true };
  assert.deepEqual(schema.parse(parameters), parameters);
  for (const input of [{ ...parameters, command: 'other' }, { ...parameters, count: '2' }, { ...parameters, enabled: 'yes' }, { ...parameters, unknown: 1 }]) {
    assert.equal(schema.safeParse(input).success, false);
  }
  assert.deepEqual(schema.parse({ command: 'inspect' }), { command: 'inspect' });
  assert.equal(z.toJSONSchema(schema).additionalProperties, false);
});

test('security override resolves the official fixed node-forge for both Expo consumers without changing the SDK', () => {
  assert.match(expoRequire('./package.json').version, /^58\./);
  for (const consumer of [cliRequire, certificateRequire]) {
    assert.equal(consumer('node-forge/package.json').version, '1.4.1');
    assert.equal(consumer.resolve('node-forge/package.json'), cliRequire.resolve('node-forge/package.json'));
  }
});

for (const [name, children] of [
  ['installed node-forge rejects an extra nested DigestAlgorithm element after NULL', () => [oid(), nil(), node(asn1.Type.OCTETSTRING, false, 'garbage')]],
  ['installed node-forge rejects an unconsumed nested DigestAlgorithm element without NULL', () => [oid(), node(asn1.Type.OCTETSTRING, false, 'garbage')]],
]) test(name, () => {
  assert.throws(() => keyPair.publicKey.verify(digest, digestSignature(children())), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
});

test('node-forge continues to verify valid SHA-256 DigestAlgorithm encodings with and without NULL', () => {
  for (const children of [[oid()], [oid(), nil()]]) assert.equal(keyPair.publicKey.verify(digest, digestSignature(children)), true);
  assert.equal(keyPair.publicKey.verify('wrong digest', digestSignature([oid(), nil()])), false);
});

test('installed node-forge rejects the upstream public low-exponent forgery vector without requiring a private key', () => {
  const vector = require('./fixtures/node-forge-nested-digest-public-vector.json');
  const publicKey = forge.pki.rsa.setPublicKey(new forge.jsbn.BigInteger(vector.modulusHex, 16), new forge.jsbn.BigInteger(String(vector.exponent)));
  const expectedDigest = forge.md.sha256.create().update(vector.message).digest().getBytes();
  assert.throws(() => publicKey.verify(expectedDigest, forge.util.hexToBytes(vector.signatureHex)), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
});

test('Expo certificate creation, validation and manifest signing still work with the strict node-forge parser', () => {
  const certificate = certificates.generateSelfSignedCodeSigningCertificate({ keyPair, commonName: 'LiFlow temporary test',
    validityNotBefore: new Date(Date.now() - 86400000), validityNotAfter: new Date(Date.now() + 86400000) });
  certificates.validateSelfSignedCertificate(certificate, keyPair);
  const payload = Buffer.from('temporary manifest validation');
  const signature = certificates.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, payload);
  assert.equal(verify('sha256', payload, pem.publicKey, Buffer.from(signature, 'base64')), true);
});

test('official node-forge rejects noncanonical DigestInfo lengths and nonempty NULL parameters', () => {
  assert.throws(() => keyPair.publicKey.verify(digest, digestSignature([oid(), node(asn1.Type.NULL, false, 'invalid')])), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  const info = asn1.toDer(node(asn1.Type.SEQUENCE, true, [node(asn1.Type.SEQUENCE, true, [oid(), nil()]), node(asn1.Type.OCTETSTRING, false, digest)])).getBytes();
  assert.ok(info.charCodeAt(1) < 128);
  const nonminimalLength = info[0] + '\x81' + info[1] + info.slice(2);
  const signature = keyPair.privateKey.sign(nonminimalLength, 'NONE');
  assert.throws(() => keyPair.publicKey.verify(digest, signature), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
});
