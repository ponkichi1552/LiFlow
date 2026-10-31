import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { plannerLightColors, plannerDarkColors } from '../src/components/planner-theme.ts';
import { createTypography } from '../src/components/planner-text-roles.ts';
import { createRequire } from 'node:module';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { contrastRatio } from './helpers/color-contrast.mjs';

const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

test('Metro resolves native semantic typography on both mobile platforms while sharing one text scale', () => {
  const { resolve } = createRequire(import.meta.url)('metro-resolver');
  const directory = fileURLToPath(new URL('../src/components/', import.meta.url));
  for (const platform of ['ios', 'android']) {
    const result = resolve({ originModulePath: join(directory, 'planner-ui.tsx'),
      sourceExts: ['js', 'jsx', 'json', 'ts', 'tsx'], assetExts: new Set(), preferNativePlatform: true,
      getPackageForModule() { return null; }, fileSystemLookup(path) {
        try { return { exists: true, type: statSync(path).isDirectory() ? 'd' : 'f', realPath: realpathSync(path) }; }
        catch { return { exists: false }; }
      },
    }, './planner-typography', platform);
    assert.ok(result.filePath.endsWith('/planner-typography.native.ts'));
  }
});

test('shared text roles include native semantic foregrounds so uncolored notices remain readable in both themes', () => {
  for (const palette of [plannerLightColors, plannerDarkColors]) {
    const { typography } = loadNativeModule('src/components/planner-typography.native.ts', { './planner-colors': { palette }, './planner-text-roles.ts': { createTypography } });
    const themeColors = new Set(Object.values(palette));
    for (const [role, style] of Object.entries(typography)) {
      assert.ok(themeColors.has(style.color), `${role}: native foreground comes from the active theme`);
      assert.ok(contrastRatio(style.color, palette.surface) >= 4.5, `${role}: native text remains readable`);
    }
    // Native colors are dynamic opaque values, not only hex strings resolved at startup.
    const tokens = Object.fromEntries(Object.keys(palette).map(key => [key, Object.freeze({ semantic: key })]));
    const dynamic = loadNativeModule('src/components/planner-typography.native.ts', { './planner-colors': { palette: tokens }, './planner-text-roles.ts': { createTypography } }).typography;
    const dynamicColors = new Set(Object.values(tokens));
    for (const style of Object.values(dynamic)) assert.ok(dynamicColors.has(style.color), 'opaque native theme values remain intact');
  }
});

for (const platform of ['ios', 'android']) test(`${platform} shared daily load warning keeps every native paragraph readable in both themes`, () => {
  for (const palette of [plannerLightColors, plannerDarkColors]) {
    const { typography } = loadNativeModule('src/components/planner-typography.native.ts', { './planner-colors': { palette }, './planner-text-roles.ts': { createTypography } });
    const screen = screenHarness('src/features/sharing/v2-ui/daily-load-notice.tsx', { exportName: 'V2DailyLoadNotice', platform, props: {
      assessment: { privateStatus: 'unavailable', limits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, scopes: [
        { source: 'shared', date: '2026-10-31', timeZone: 'Asia/Tokyo', load: { heavy: 1, normal: 0, total: 1 }, reached: ['heavy'] },
      ] },
    }, mocks: { '../../../components/planner-ui': { Card: 'Card', palette, typography } } });
    const paragraphs = screen.nodes().filter(node => node.type === 'Text');
    assert.ok(paragraphs.length > 0);
    for (const row of paragraphs) assert.ok(contrastRatio(flatten(row.props.style).color, palette.surface) >= 4.5,
      'notices remain readable after native theme changes');
  }
});

test('ThemedText keeps explicit theme and caller color precedence when text roles supply default foregrounds', () => {
  for (const [type, themeColor, style, expected] of [
    ['default', undefined, undefined, '#EEEEEE'], ['small', 'secondary', undefined, '#AACCFF'],
    ['linkPrimary', undefined, { color: '#2244CC' }, '#2244CC'], ['title', 'secondary', { color: '#FFCC00' }, '#FFCC00'],
  ]) {
    const screen = screenHarness('src/components/themed-text.tsx', { exportName: 'ThemedText', props: { type, themeColor, style, children: 'theme sample' }, mocks: {
      '@/hooks/use-theme': { useTheme: () => ({ text: '#EEEEEE', secondary: '#AACCFF' }) },
      '@/constants/theme': { Fonts: { mono: 'monospace' } },
      'react-native': { Text: 'Text', StyleSheet: { create: values => values }, Platform: { select: () => 500 } },
    } });
    assert.equal(flatten(screen.nodes().find(node => node.type === 'Text').props.style).color, expected);
  }
});

test('compact button typography preserves primary secondary quiet and destructive foreground meanings in both themes', () => {
  for (const palette of [plannerLightColors, plannerDarkColors]) for (const compact of [false, true]) {
    for (const [variant, color] of Object.entries({ primary: palette.accentInk, secondary: palette.accent, quiet: palette.muted, danger: palette.warning })) {
      const screen = screenHarness('src/components/planner-ui.tsx', { exportName: 'AppButton', props: { variant, compact, title: 'Action', onPress() {} },
        mocks: { './planner-colors': { palette } } });
      assert.equal(flatten(screen.nodes().find(node => node.type === 'Text').props.style).color, color, `${variant} compact=${compact}`);
    }
  }
});

test('native tab labels keep navigator controlled active and inactive tint rather than a typography foreground override', () => {
  const screen = screenHarness('src/components/app-tabs.tsx');
  const options = screen.nodes().find(node => node.props.screenOptions)?.props.screenOptions;
  assert.ok(options); assert.equal(flatten(options.tabBarLabelStyle).color, undefined);
  assert.equal(options.tabBarActiveTintColor, plannerLightColors.accent);
  assert.equal(options.tabBarInactiveTintColor, plannerLightColors.muted);
});
