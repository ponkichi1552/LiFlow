import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { alignMaterialSymbol } = require('../scripts/patch-expo-symbols-android-alignment.cjs');
test('Android Material icons ignore text scaling and font padding so their complete glyph stays centered in a fixed square', () => {
  const source = `return <View><Text aria-hidden style={{fontFamily: font.name, fontSize: size, lineHeight: size,}}>{androidSymbolToString(name)}</Text></View>`;
  const fixed = alignMaterialSymbol(source); assert.equal(alignMaterialSymbol(fixed), fixed);
  assert.ok(fixed.includes('allowFontScaling={false}')); assert.ok(fixed.includes('includeFontPadding: false')); assert.ok(fixed.includes('textAlignVertical: "center"'));
  const build = ts.transpileModule(fixed, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX } }).outputText;
  assert.ok(build.includes('allowFontScaling: false')); assert.equal(alignMaterialSymbol(build, true), build);
  assert.throws(() => alignMaterialSymbol('unknown renderer'), /renderer changed/);
  for (const file of ['src/SymbolView.tsx', 'build/SymbolView.js']) {
    const installed = readFileSync(new URL(`../node_modules/expo-symbols/${file}`, import.meta.url), 'utf8');
    assert.ok(installed.includes('includeFontPadding: false')); assert.equal(alignMaterialSymbol(installed, file.endsWith('.js')), installed);
  }
});
