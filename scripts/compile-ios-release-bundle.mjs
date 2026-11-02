import { readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Match react-native-xcode.sh: Release Hermes bundles must use -emit-binary -O.
export function assertHermesBundle(bytes, expectedVersion) {
  if (bytes.length < 12 || bytes.subarray(0, 8).toString('hex') !== 'c61fbc03c103191f'
    || bytes.readUInt32LE(8) !== expectedVersion) throw new Error('Release用のHermesバイトコードを確認できません。');
}
export function compileIosReleaseBundle(input, output, compiler = fileURLToPath(new URL('../ios/Pods/hermes-engine/destroot/bin/hermesc', import.meta.url))) {
  if (resolve(input) === resolve(output)) throw new Error('元のJavaScriptと出力先は別にしてください。');
  const version = /HBC bytecode version:\s*(\d+)/u.exec(execFileSync(compiler, ['--version'], { encoding: 'utf8' }));
  if (!version) throw new Error('このiOSビルドに対応するHermesコンパイラーを確認してください。');
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    execFileSync(compiler, ['-emit-binary', '-max-diagnostic-width=80', '-O', '-out', temporary, input], { stdio: 'pipe' });
    assertHermesBundle(readFileSync(temporary), Number(version[1])); renameSync(temporary, output);
  } finally { rmSync(temporary, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/compile-ios-release-bundle.mjs source.js main.jsbundle');
  compileIosReleaseBundle(process.argv[2], process.argv[3]);
}
