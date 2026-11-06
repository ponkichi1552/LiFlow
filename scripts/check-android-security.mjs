import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { AndroidConfig } = require('expo/config-plugins');
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(path.join(root, 'android/app/src/main/AndroidManifest.xml'));
const receiver = manifest.manifest.application?.[0]?.receiver?.find(row => /(?:^|\.)NextChoreWidgetProvider$/u.test(row.$['android:name']));
assert.ok(receiver, 'Generated widget receiver is missing');
assert.equal(receiver.$['android:exported'], 'false', 'External apps must not be able to invoke widget completion');
assert.ok(receiver['meta-data']?.some(row => row.$['android:name'] === 'android.appwidget.provider'));
const res = path.join(root, 'android/app/src/main/res');
const read = folder => AndroidConfig.Resources.readResourcesXMLAsync({ path: path.join(res, folder, folder === 'values' ? 'styles.xml' : 'liflow_api_styles.xml'), fallback: null });
const base = await read('values');
for (const [name, api] of [['android:windowLightNavigationBar', 27], ['android:enforceNavigationBarContrast', 29], ['android:windowSplashScreenBehavior', 33]]) {
  assert.ok(!base.resources.style.some(style => style.item?.some(item => item.$.name === name)), `${name} is not supported on API24`);
  const qualified = await read(`values-v${api}`);
  assert.ok(qualified.resources.style.some(style => style.item?.some(item => item.$.name === name)), `${name} disappeared from its supported API`);
}
const gradle = await readFile(path.join(root, 'android/app/build.gradle'), 'utf8');
const widgetDirectory = path.join(root, 'android/app/src/main/java/jp/jphacks/tkb2633');
assert.equal(await readFile(path.join(widgetDirectory, 'WidgetCompletionDatabase.kt'), 'utf8'),
  await readFile(path.join(root, 'plugins/android/WidgetCompletionDatabase.kt'), 'utf8'), 'Generated widget input bridge is stale');
const provider = await readFile(path.join(widgetDirectory, 'NextChoreWidgetProvider.kt'), 'utf8');
assert.match(provider, /goAsync\(\)/); assert.match(provider, /WidgetCompletionDatabase\.enqueue\(/); assert.match(provider, /pending\.finish\(\)/);
assert.doesNotMatch(provider, /WidgetCompletionDatabase\.complete\(/);
const securityDependencies = require('../plugins/with-android-security-dependencies.js');
assert.equal(securityDependencies.addSecurityConstraints(gradle), gradle, 'Generated Android dependency security constraints are missing or stale');
console.log('Generated Android security boundaries, dependency minimums and API24-qualified themes: PASS');
