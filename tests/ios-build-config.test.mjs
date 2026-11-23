import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo;
const source = readFileSync(new URL('../app.config.js', import.meta.url), 'utf8');

function configure(env) {
  const module = { exports: {} };
  runInNewContext(source, { module, process: { env }, require: createRequire(new URL('../app.config.js', import.meta.url)) });
  return module.exports({ config: structuredClone(config) });
}

test('local reminders do not require APNs, while widget App Groups remain configured', () => {
  const notifications = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-notifications');
  assert.equal(notifications?.[1].enableRemoteNotifications, false);
  const widgets = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets');
  assert.equal(widgets[1].groupIdentifier, 'group.jp.jphacks.tkb2633');
  assert.equal(widgets[1].enableAndroid, true);
});

test('physical iOS builds accept an optional local signing team without changing app or OAuth identity', () => {
  assert.equal(configure({}).ios.appleTeamId, undefined);
  const result = configure({
    APPLE_TEAM_ID: ' ABC1234567 ',
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
    EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'ios.apps.googleusercontent.com',
  });
  assert.equal(result.ios.appleTeamId, 'ABC1234567');
  assert.equal(result.ios.bundleIdentifier, config.ios.bundleIdentifier);
  assert.equal(result.android.package, config.android.package);
  assert.equal(result.extra.googleSyncOAuth.configured, true);
  assert.equal(result.extra.googleSyncOAuth.iosClientId, 'ios.apps.googleusercontent.com');
  assert.equal(result.extra.APPLE_TEAM_ID, undefined);
  assert.throws(() => configure({ APPLE_TEAM_ID: 'invalid' }), /APPLE_TEAM_ID/);
});
