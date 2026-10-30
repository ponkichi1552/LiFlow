import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const plugin = require('../plugins/with-android-security-dependencies.js');

test('Android runtime security minimums survive repeated prebuilds without forcing older native versions or removing app dependencies', async () => {
  const original = 'apply plugin: "com.android.application"\nandroid {\n    defaultConfig { minSdkVersion 24 }\n}\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n';
  const once = plugin.addSecurityConstraints(original);
  assert.equal(plugin.addSecurityConstraints(once), once);
  assert.equal(once.match(/constraints \{/gu)?.length, 1);
  assert.ok(once.includes('implementation("com.facebook.react:react-android")'));
  for (const [coordinate, version] of [['commons-io:commons-io', '2.14.0'], ['com.google.code.gson:gson', '2.8.9'], ['com.google.guava:guava', '33.7.2-android']]) {
    assert.ok(once.includes(`implementation('${coordinate}')`));
    assert.ok(once.includes(`require('${version}')`));
  }
  assert.doesNotMatch(once, /strictly|resolutionStrategy|\bforce\b/u);
  assert.throws(() => plugin.addSecurityConstraints(original, 'kotlin'), /Groovy/);
  assert.throws(() => plugin.addSecurityConstraints('unrecognized native template'), /Failed to match/);
  const config = require('../app.config.js')({ config: { name: 'LiFlow', slug: 'liflow' } });
  assert.ok(config.plugins.includes('./plugins/with-android-security-dependencies'));
  const mod = plugin(config);
  const result = await mod.mods.android.appBuildGradle({ ...mod, modRequest: { platform: 'android', modName: 'appBuildGradle' }, modResults: { language: 'groovy', contents: original } });
  assert.equal(result.modResults.contents, once);
});

test('Android file library security updates retain API24 NIO support without increasing minSdk or changing the Java target', () => {
  const source = 'android {\n    defaultConfig { minSdkVersion 24 }\n    compileOptions { sourceCompatibility JavaVersion.VERSION_17 }\n}\ndependencies {\n}\n';
  const result = plugin.addSecurityConstraints(source);
  assert.match(result, /coreLibraryDesugaringEnabled true/u);
  assert.match(result, /coreLibraryDesugaring\('com\.android\.tools:desugar_jdk_libs_nio:2\.1\.5'\)/u);
  assert.match(result, /minSdkVersion 24/u); assert.match(result, /sourceCompatibility JavaVersion\.VERSION_17/u);
  assert.equal(plugin.addSecurityConstraints(result), result);
});
