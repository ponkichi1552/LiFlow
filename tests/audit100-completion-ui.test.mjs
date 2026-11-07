import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
const repository = await import('../src/platform/storage/repository.ts');

for (const platform of ['ios', 'android']) test(`${platform} audit100 a temporarily rejected queued Undo retains its one-tap recovery action`, async t => {
  const h = await privateFixture(); t.after(() => h.connection.close());
  const snapshot = await repository.loadPlannerSnapshot(h.database);
  const state = { values: new Map(), pending: new Set(), failed: new Set(), restored: true, error: null };
  const runtime = { acquire: () => () => {}, watchDisplay: () => () => {}, queue: {
    getSnapshot: () => state, subscribe: () => () => {}, retryRead() {}, retryFailed() {},
    request(key, target, completed) { return completed; },
  } };
  const screen = screenHarness('src/app/(tabs)/index.tsx', { platform, database: h.database, snapshot: () => snapshot, refresh: async () => {},
    effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
    mocks: { '../platform/storage/completion-intents': { personalCompletionIntents: () => runtime } } });
  t.after(() => screen.unmount()); await screen.flush();
  const box = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox'); assert.ok(box);
  box.props.onPress(); await screen.flush();
  const toast = () => screen.nodes().find(node => node.props.accessibilityLabel === '直前の完了を元に戻す');
  assert.ok(toast()); await screen.press('直前の完了を元に戻す');
  assert.ok(toast(), 'a refusal must not discard the still-unused Undo');
});
