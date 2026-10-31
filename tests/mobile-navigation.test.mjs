import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate } from '../src/domain/scheduling/local-date.ts';

const repository = await import('../src/platform/storage/repository.ts');

test('mobile back controls return to the previous route across screens', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database, localDateFromDate(new Date()));
    for (const route of ['src/app/help.tsx', 'src/app/history.tsx', 'src/app/waste.tsx',
      'src/app/chores/index.tsx', 'src/app/chores/[id].tsx', 'src/app/settings.tsx',
      'src/app/(tabs)/manual/appliance-care.tsx']) {
      const calls = [];
      const screen = screenHarness(route, {
        database: h.database, snapshot: () => snapshot, params: { id: snapshot.chores[0].id },
        navigate: (...args) => calls.push(args),
        mocks: { '@/features/google-sync/background-task': {},
          '@/features/appliance-care/api-client': {},
          '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
          '@/platform/google-tasks/google-sign-in-gateway': {},
        },
      });
      await screen.press('前の画面に戻る');
      assert.deepEqual(calls, [['back']], `${route}: previous route`);
    }
  } finally { h.connection.close(); }
});

test('mobile onboarding back control retains selections when moving backward and forward', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database, localDateFromDate(new Date()));
    const screen = screenHarness('src/features/onboarding/first-run-setup.tsx', {
      exportName: 'FirstRunSetup', database: h.database, props: { snapshot, onComplete: async () => {} },
    });
    const firstPage = screen.text();
    await screen.press('次へ');
    assert.ok(screen.text().includes('休日'));
    await screen.press('戻る');
    assert.equal(screen.text(), firstPage);
    await screen.press('次へ');
    assert.ok(screen.text().includes('休日'));
  } finally { h.connection.close(); }
});
