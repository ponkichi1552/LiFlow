import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const calendarApi = () => require('../../src/platform/google-calendar/calendar-api.ts');

export function loadNativeModule(filename, mocks, timers = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8'), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', outputText)((name) => {
    if (!(name in mocks) && ['../subscription/runtime', '@/platform/subscription/runtime'].includes(name)) return {
      subscriptionRequired: false, assertSubscriptionAccess: async () => {}, subscriptionAccessDeadline: async () => Infinity,
    };
    if (!(name in mocks) && name === '../google-calendar/calendar-api') return calendarApi();
    if (!(name in mocks) && name === '@/platform/diagnostics/startup-timing') return require('../../src/platform/diagnostics/startup-timing.ts');
    if (!(name in mocks) && name === './src/platform/diagnostics/startup-clock') return require('../../src/platform/diagnostics/startup-clock.ts');
    if (!(name in mocks) && name === '@/features/planner/initial-display-gate') return require('../../src/features/planner/initial-display-gate.ts');
    if (!(name in mocks) && name === '@/platform/sharing/startup-display') return { readSavedStartupDisplay: async () => undefined, startupDisplayCache: { read: async () => undefined } };
    assert.ok(name in mocks, `unmocked native import ${name}`); return mocks[name];
  }, module, module.exports, timers.setTimeout ?? globalThis.setTimeout, timers.clearTimeout ?? globalThis.clearTimeout);
  return module.exports;
}
