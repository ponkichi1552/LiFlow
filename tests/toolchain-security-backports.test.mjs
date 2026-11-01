import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const patches = require('../scripts/patch-glob-security.cjs');
for (const format of ['commonjs', 'esm']) {
  const directory = name => join(import.meta.dirname, '../node_modules', name, 'dist', format);
  const minimatch = format === 'commonjs' ? require(join(directory('minimatch'), 'index.js')) : await import(pathToFileURL(join(directory('minimatch'), 'index.js')).href);
  const glob = format === 'commonjs' ? require(join(directory('glob'), 'index.js')) : await import(pathToFileURL(join(directory('glob'), 'index.js')).href);
  test(`${format} minimatch bounds globstar-parent amplification and preserves ordinary toolchain matching`, () => {
    const hostile = new minimatch.Minimatch('**/../a/'.repeat(10) + 'z', { optimizationLevel: 2, braceExpandMax: 8 });
    assert.ok(hostile.globParts.length <= 8);
    for (const [pattern, file, expected] of [['src/*.ts', 'src/a.ts', true], ['src/*.ts', 'src/b.tsx', false],
      ['src/**/*.ts', 'src/nested/a.ts', true], ['src/{a,b}.tsx', 'src/b.tsx', true], ['**/tests/*.mjs', 'x/tests/probe.mjs', true]]) {
      assert.equal(minimatch.minimatch(file, pattern, { optimizationLevel: 2 }), expected, `${pattern}: ${file}`);
    }
    const matcher = new minimatch.Minimatch('*'); let comparisons = 0;
    matcher.partsMatch = () => { comparisons++; return false; };
    const many = Array.from({ length: 1001 }, (_, index) => [String(index), '*']);
    assert.equal(matcher.secondPhasePreProcess(many), many); assert.equal(comparisons, 0);
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
test('toolchain security backports are idempotent and reject unknown replacement targets', () => {
  for (const format of ['commonjs', 'esm']) for (const [name, file, patch] of [['glob', 'walker.js', patches.patchGlob], ['minimatch', 'index.js', patches.patchMinimatch]]) {
    const source = fs.readFileSync(join(import.meta.dirname, '../node_modules', name, 'dist', format, file), 'utf8');
    assert.equal(patch(source), source); assert.throws(() => patch('changed upstream source'));
  }
  const legacy = require('../node_modules/eslint/node_modules/minimatch');
  assert.equal(typeof legacy, 'function'); assert.equal(legacy('src/file.ts', '**/*.ts'), true, 'ESLint retains its v3 callable API');
});
