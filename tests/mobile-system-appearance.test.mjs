import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { screenHarness } from './helpers/screen-harness.mjs';

const require = createRequire(import.meta.url);
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo;
const android = require('expo-system-ui/plugin/build/withAndroidUserInterfaceStyle');
const ios = require('expo-system-ui/plugin/build/withIosUserInterfaceStyle');
const statusBar = require(fileURLToPath(new URL('../node_modules/expo-status-bar/plugin/build/withStatusBar.js', import.meta.url)));
const navigationBar = require(fileURLToPath(new URL('../node_modules/expo-navigation-bar/plugin/build/withNavigationBar.js', import.meta.url)));

test('the planner follows system native appearance on both platforms without changing identity resources', () => {
  const strings = android.setStrings({ resources: { string: [{ $: { name: 'app_name' }, _: 'LiFlow' }] } }, android.resolveProps(config));
  assert.equal(strings.resources.string.find((item) => item.$.name === 'expo_system_ui_user_interface_style')._, 'automatic');
  assert.equal(strings.resources.string.find((item) => item.$.name === 'app_name')._, 'LiFlow');
  const info = ios.setUserInterfaceStyle(config, { CFBundleIdentifier: config.ios.bundleIdentifier });
  assert.equal(info.UIUserInterfaceStyle, 'Automatic');
  assert.equal(info.CFBundleIdentifier, 'jp.jphacks.tkb2633');

  const statusOptions = config.plugins.find((item) => item[0] === 'expo-status-bar')[1];
  const navigationOptions = config.plugins.find((item) => item[0] === 'expo-navigation-bar')[1];
  let styles = { resources: { style: [{ $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' }, item: [] }] } };
  styles = statusBar.setAndroidStatusBarStyles(styles, statusOptions);
  styles = navigationBar.setNavigationBarStyles(navigationOptions, styles);
  for (const name of ['android:windowLightStatusBar', 'android:windowLightNavigationBar']) {
    assert.equal(styles.resources.style[0].item.find((item) => item.$.name === name)._, 'true');
  }
  assert.equal(navigationOptions.enforceContrast, false);
  const layout = readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /<PlannerSystemBars\s*\/>/);
});

for (const platform of ['ios', 'android']) for (const colorScheme of ['light', 'dark']) {
  test(`${platform} planner keeps readable status icons in ${colorScheme} and only Android configures navigation buttons`, () => {
    const screen = screenHarness('src/components/planner-system-bars.tsx', {
      platform, colorScheme, exportName: 'PlannerSystemBars',
      mocks: { 'expo-status-bar': { StatusBar: 'StatusBar' }, 'expo-navigation-bar': { NavigationBar: 'NavigationBar' } },
    });
    assert.equal(screen.nodes().find((node) => node.type === 'StatusBar').props.style, colorScheme === 'dark' ? 'light' : 'dark');
    const navigation = screen.nodes().find((node) => node.type === 'NavigationBar');
    assert.equal(Boolean(navigation), platform === 'android');
    if (navigation) assert.equal(navigation.props.style, colorScheme === 'dark' ? 'light' : 'dark');
  });
}
