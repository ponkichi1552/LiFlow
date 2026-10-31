import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function loadNativeModule(filename, mocks, timers = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8'), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', outputText)((name) => {
    assert.ok(name in mocks, `unmocked native import ${name}`); return mocks[name];
  }, module, module.exports, timers.setTimeout ?? globalThis.setTimeout, timers.clearTimeout ?? globalThis.clearTimeout);
  return module.exports;
}
