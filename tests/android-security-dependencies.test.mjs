import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const plugin = require('../plugins/with-android-security-dependencies.js');

test('Android runtime security minimums survive repeated prebuilds without forcing older native versions or removing app dependencies', async () => {
  const original = 'apply plugin: "com.android.application"\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n';
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
