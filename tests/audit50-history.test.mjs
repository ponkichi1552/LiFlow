import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
function history(completions, extra = {}) {
  const snapshot = { today: '2026-11-07', timeZone: 'UTC', chores: completions.map(row => ({ id: row.choreId, name: row.choreId })), completions, ...extra };
  return screenHarness('src/features/planner/history-content.tsx', { exportName: 'PlannerHistoryContent', props: {
    data: { snapshot, loading: false, error: null, refresh: async () => {} } } });
}

test('audit50 the latest hundred history cards retain the newest actual completion across mixed offset spellings', () => {
  const older = Array.from({ length: 100 }, (_, n) => ({ id: `old-${n}`, choreId: `older-${n}`, outcome: 'completed', completedAt: '2026-11-07T15:00:00+09:00', completedLocalDate: '2026-11-07' }));
  const newest = { id: 'newest', choreId: 'newest-visible-work', outcome: 'completed', completedAt: '2026-11-07T08:00:00Z', completedLocalDate: '2026-11-07' };
  const ui = history([...older, newest]);
  try { assert.match(ui.text(), /newest-visible-work/); } finally { ui.unmount(); }
});

test('audit50 history without a frozen civil date uses the owner region for its month count and day heading', () => {
  const priorZone = process.env.TZ; process.env.TZ = 'UTC';
  const row = { id: 'legacy', choreId: 'legacy-work', outcome: 'completed', completedAt: '2026-11-01T01:00:00Z' };
  const ui = history([row], { today: '2026-10-31', timeZone: 'America/Los_Angeles' });
  try {
    assert.match(ui.text(), /10月31日/); assert.doesNotMatch(ui.text(), /11月1日/);
    assert.match(ui.text(), /今月の完了1件/);
  } finally { ui.unmount(); if (priorZone === undefined) delete process.env.TZ; else process.env.TZ = priorZone; }
});
