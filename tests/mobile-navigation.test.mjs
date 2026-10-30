import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { localDateFromDate } from '../src/domain/scheduling/local-date.ts';
import { typography } from '../src/components/planner-typography.ts';

const repository = await import('../src/platform/storage/repository.ts');

test('mobile back controls share a readable label and touch area while preserving route callbacks', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database, localDateFromDate(new Date()));
    let commonStyle;
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
      const back = screen.button('前の画面に戻る');
      const text = back.children.find((child) => child.type === 'Text');
      assert.deepEqual(text.children, ['戻る'], `${route}: visible label`);
      assert.equal(text.props.style.fontSize, typography.control.fontSize, `${route}: shared readable control size`);
      const style = back.props.style({ pressed: false })[0];
      assert.ok(style.minHeight >= 48, `${route}: touch area`);
      commonStyle ??= style;
      assert.deepEqual(style, commonStyle, `${route}: consistent control`);
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

test('mobile tab bar reserves space for labels on phones with and without a home indicator', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database, localDateFromDate(new Date()));
    snapshot.settings.setupCompleted = true;
    for (const bottom of [0, 34]) {
      const mocks = { 'expo-symbols': { SymbolView: 'SymbolView' },
        'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom }) },
      };
      const screen = screenHarness('src/components/app-tabs.tsx', { mocks });
      const options = screen.nodes().find((node) => node.props.screenOptions).props.screenOptions;
      assert.equal(options.tabBarStyle.paddingBottom, bottom);
      assert.ok(options.tabBarStyle.height - bottom >= 60, 'icon and readable label need room above the safe area');
      assert.deepEqual(options.tabBarLabelStyle, { fontSize: typography.tab.fontSize, lineHeight: typography.tab.lineHeight, fontWeight: '600' },
        'shared font metrics remain intact while the navigator owns active/inactive label colors');
      const home = screenHarness('src/app/(tabs)/index.tsx', { database: h.database, snapshot: () => snapshot, mocks });
      const homeTabStyle = home.nodes().find((node) => node.props.options?.tabBarStyle).props.options.tabBarStyle;
      assert.deepEqual(homeTabStyle, options.tabBarStyle, 'home must not replace the shared tab bar with the previous short layout');
    }
  } finally { h.connection.close(); }
});
