import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { toolchainSecurityInventory } from '../scripts/toolchain-security-inventory.mjs';
const require = createRequire(import.meta.url);
const { verify } = require('../scripts/verify-glob-security.cjs');
for (const format of ['commonjs', 'esm']) {
  const directory = name => join(import.meta.dirname, '../node_modules', name, 'dist', format);
  const minimatch = format === 'commonjs' ? require(join(directory('minimatch'), 'index.js')) : await import(pathToFileURL(join(directory('minimatch'), 'index.js')).href);
  const glob = format === 'commonjs' ? require('glob') : await import('glob');
  test(`${format} minimatch bounds globstar-parent amplification and preserves ordinary toolchain matching`, () => {
    assert.throws(() => new minimatch.Minimatch('**/../a/'.repeat(10) + 'z',
      { optimizationLevel: 2, braceExpandMax: 8 }), /too many patterns/);
    for (const [pattern, file, expected] of [['src/*.ts', 'src/a.ts', true], ['src/*.ts', 'src/b.tsx', false],
      ['src/**/*.ts', 'src/nested/a.ts', true], ['src/{a,b}.tsx', 'src/b.tsx', true], ['**/tests/*.mjs', 'x/tests/probe.mjs', true]]) {
      assert.equal(minimatch.minimatch(file, pattern, { optimizationLevel: 2 }), expected, `${pattern}: ${file}`);
    }
    const matcher = new minimatch.Minimatch('*'); let comparisons = 0;
    matcher.partsMatch = () => { comparisons++; return false; };
    const many = Array.from({ length: 1001 }, (_, index) => [String(index), '*']);
    assert.deepEqual(matcher.secondPhasePreProcess(many), many); assert.equal(comparisons, 0);
  });
  for (const sync of [false, true]) test(`${format} glob ${sync ? 'sync' : 'async'} does not start more filesystem reads after abort`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'liflow-abort-'));
    try {
      for (let i = 0; i < 12; i++) { await mkdir(join(cwd, String(i))); await writeFile(join(cwd, String(i), 'fixture.txt'), 'synthetic'); }
      const controller = new AbortController(); let reads = 0; let afterAbort = 0;
      const filesystem = { ...fs,
        readdir(path, options, callback) { if (controller.signal.aborted) afterAbort++; reads++;
          return fs.readdir(path, options, (error, result) => { controller.abort(new Error('synthetic stop')); callback(error, result); }); },
        readdirSync(path, options) { if (controller.signal.aborted) afterAbort++; reads++;
          const result = fs.readdirSync(path, options); controller.abort(new Error('synthetic stop')); return result; },
      };
      try {
        if (sync) glob.globSync('**/*', { cwd, fs: filesystem, signal: controller.signal });
        else await glob.glob('**/*', { cwd, fs: filesystem, signal: controller.signal });
      } catch (error) { assert.match(String(error), /synthetic stop/); }
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      assert.ok(reads >= 1); assert.equal(afterAbort, 0);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
test('official toolchain security versions verify without mutation and reject unreviewed replacements', async () => {
  const before = toolchainSecurityInventory(); verify(); verify(); assert.deepEqual(toolchainSecurityInventory(), before);
  const root = await mkdtemp(join(tmpdir(), 'liflow-dependency-version-'));
  try {
    for (const [name, version] of [['glob', '13.0.6'], ['minimatch', '11.0.5']]) {
      await mkdir(join(root, name)); await writeFile(join(root, name, 'package.json'), JSON.stringify({ version }));
    }
    assert.throws(() => verify(root), /glob changed/);
    await writeFile(join(root, 'glob', 'package.json'), JSON.stringify({ version: '14.0.4' }));
    await writeFile(join(root, 'minimatch', 'package.json'), JSON.stringify({ version: '10.2.6' }));
    assert.throws(() => verify(root), /minimatch changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
  const legacy = require('../node_modules/eslint/node_modules/minimatch');
  assert.equal(typeof legacy, 'function'); assert.equal(legacy('src/file.ts', '**/*.ts'), true, 'ESLint retains its v3 callable API');
});

test('every resolved legacy minimatch copy avoids amplification without replacing its callable ESLint API', () => {
  const inventory = toolchainSecurityInventory();
  assert.ok(inventory.some(row => row.name === 'glob'));
  assert.ok(inventory.some(row => row.name === 'minimatch' && row.version === '11.0.5'));
  for (const row of inventory) {
    assert.ok(row.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256)));
    if (row.name === 'glob') { assert.equal(row.version, '14.0.4', 'review new copies before assuming the root version covers them'); assert.equal(row.path, 'node_modules/glob'); continue; }
    assert.ok(['3.1.5', '11.0.5'].includes(row.version), 'new versions need an explicit security/behavior review');
    if (row.version !== '3.1.5') { assert.equal(row.path, 'node_modules/minimatch'); continue; }
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict'); const m = require(process.argv[1]);
      assert.equal(typeof m, 'function');
      const pattern = '**/../a/'.repeat(18) + 'z';
      const hostile = new m.Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 8 });
      assert.equal(hostile.globParts.length, 1);
      assert.equal(m('src/a.ts', 'src/**/*.ts'), true); assert.equal(m('src/a.tsx', 'src/**/*.ts'), false);
    `, resolve(import.meta.dirname, '..', row.path)], { timeout: 3000, encoding: 'utf8' });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  }
});

test('official matchers preserve Expo fingerprint exclusions negated overrides and platform file matching', () => {
  const fingerprint = require('@expo/fingerprint/build/utils/Path.js');
  for (const [file, patterns, ignored] of [
    ['src/a.ts', ['node_modules/**'], false], ['node_modules/x/a.ts', ['node_modules/**'], true],
    ['src/a.test.ts', ['**/*.test.ts'], true], ['src/keep.test.ts', ['**/*.test.ts', '!src/keep.test.ts'], false],
  ]) assert.equal(fingerprint.isIgnoredPath(file, patterns), ignored);
  const { minimatch } = require('minimatch');
  for (const [file, pattern, expected] of [
    ['src/a.ios.tsx', 'src/**/*.ios.{ts,tsx}', true], ['src/a.android.tsx', 'src/**/*.ios.{ts,tsx}', false],
    ['src/nested/.hidden.ts', 'src/**/.*.ts', true], ['src/a.tsx', 'src/!(*.test).tsx', true],
    ['src/a.test.tsx', 'src/!(*.test).tsx', false],
  ]) assert.equal(minimatch(file, pattern, { dot: true }), expected);
});
