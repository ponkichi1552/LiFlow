import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo;

test('LiFlow uses the same app name and icon artwork on iOS and Android without changing app identity', () => {
  assert.equal(config.name, 'LiFlow');
  assert.equal(config.icon, './assets/images/liflow-wordmark-icon.png');
  assert.equal(config.ios.icon.light, config.icon);
  assert.equal(config.ios.icon.dark, config.icon);
  assert.equal(config.android.icon, config.icon);
  assert.equal(config.android.adaptiveIcon.foregroundImage, config.icon);
  assert.equal(config.android.adaptiveIcon.backgroundImage, undefined);
  assert.equal(config.android.adaptiveIcon.monochromeImage, undefined);
  assert.equal(config.ios.bundleIdentifier, 'jp.jphacks.tkb2633');
  assert.equal(config.android.package, 'jp.jphacks.tkb2633');
  assert.equal(config.scheme, 'houseworkplanner');
  assert.ok(config.plugins.includes('./plugins/with-liflow-launcher-icons'));
  const splash = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
  assert.equal(splash[1].image, './assets/images/liflow-icon.png', 'Changing the launcher must not change the launch screen');
  assert.equal(splash[1].dark.image, './assets/images/liflow-icon-dark.png');
});

test('LiFlow icon is opaque and its white artwork fits the circular mask and Android safe zone', () => {
  const png = PNG.sync.read(readFileSync(new URL(`../${config.icon}`, import.meta.url)));
  assert.equal(png.width, png.height);
  assert.ok(png.width >= 1024);
  let whitePixels = 0, maxRadius = 0;
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
    const i = (y * png.width + x) * 4;
    assert.equal(png.data[i + 3], 255);
    if (png.data[i] > 235 && png.data[i + 1] > 235 && png.data[i + 2] > 235) {
      whitePixels += 1;
      maxRadius = Math.max(maxRadius, Math.hypot(x - (png.width - 1) / 2, y - (png.height - 1) / 2));
    }
  }
  assert.ok(whitePixels > 0, 'The supplied artwork must not be empty');
  assert.ok(maxRadius / png.width < 0.5, 'The complete wordmark must survive a circular launcher mask');
});

test('LiFlow managed icon plugin generates inset adaptive resources and keeps manifest attributes', async () => {
  const plugin = require('../plugins/with-liflow-launcher-icons.js');
  const manifest = { manifest: { application: [{ $: { 'android:name': '.MainApplication', 'android:label': '@string/app_name', 'android:allowBackup': 'false' } }] } };
  const result = plugin.setLauncherManifest(manifest);
  assert.equal(result.manifest.application[0].$['android:icon'], '@mipmap/liflow_launcher');
  assert.equal(result.manifest.application[0].$['android:roundIcon'], '@mipmap/liflow_launcher');
  assert.equal(result.manifest.application[0].$['android:name'], '.MainApplication');
  assert.equal(result.manifest.application[0].$['android:allowBackup'], 'false');
  const xml = plugin.adaptiveIconXml();
  const inset = side => Number(new RegExp(`android:inset${side}="([0-9.]+)%"`).exec(xml)[1]) / 100;
  const width = 1 - inset('Left') - inset('Right'), height = 1 - inset('Top') - inset('Bottom');
  assert.ok(width > 0 && height > 0 && width === height, 'The square source must retain its aspect ratio');
  const png = PNG.sync.read(readFileSync(new URL(`../${config.icon}`, import.meta.url)));
  let maxRadius=0;
  for (let y=0;y<png.height;y++) for(let x=0;x<png.width;x++) {
    const i=(y*png.width+x)*4;
    if (Math.min(...png.data.subarray(i,i+3)) > 235) {
      maxRadius=Math.max(maxRadius,Math.hypot(inset('Left')+width*x/png.width-.5,inset('Top')+height*y/png.height-.5)*108);
    }
  }
  assert.ok(maxRadius<33, 'all white tips remain in the Android safe circle');
  assert.ok(xml.includes('@mipmap/ic_launcher_foreground'));
  assert.ok(xml.includes('@color/iconBackground'));
  assert.ok(!xml.includes('ic_launcher_monochrome'));
});
