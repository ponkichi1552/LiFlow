import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo;

test('LiFlow uses the same app name and icon artwork on iOS and Android without changing app identity', () => {
  assert.equal(config.name, 'LiFlow');
  assert.equal(config.icon, './assets/images/liflow-icon.png');
  assert.equal(config.ios.icon.light, config.icon);
  assert.equal(config.ios.icon.dark, './assets/images/liflow-icon-dark.png');
  assert.equal(config.android.icon, config.icon);
  assert.equal(config.android.adaptiveIcon.foregroundImage, config.icon);
  assert.equal(config.android.adaptiveIcon.backgroundImage, undefined);
  assert.equal(config.android.adaptiveIcon.monochromeImage, undefined);
  assert.equal(config.ios.bundleIdentifier, 'jp.jphacks.tkb2633');
  assert.equal(config.android.package, 'jp.jphacks.tkb2633');
  assert.equal(config.scheme, 'houseworkplanner');
  assert.ok(config.plugins.includes('./plugins/with-liflow-launcher-icons'));
  const splash = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
  assert.equal(splash[1].image, config.icon);
  assert.equal(splash[1].backgroundColor, config.android.adaptiveIcon.backgroundColor);
});

test('LiFlow icon is opaque and its white artwork fits the circular mask and Android safe zone', () => {
  const png = PNG.sync.read(readFileSync(new URL('../assets/images/liflow-icon.png', import.meta.url)));
  assert.equal(png.width, png.height);
  assert.ok(png.width >= 1024);
  let whitePixels = 0, maxRadius = 0; let minX = png.width, minY = png.height, maxX = 0, maxY = 0;
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
    const i = (y * png.width + x) * 4;
    assert.equal(png.data[i + 3], 255);
    if (png.data[i] > 235 && png.data[i + 1] > 235 && png.data[i + 2] > 235) {
      whitePixels += 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      maxRadius = Math.max(maxRadius, Math.hypot(x - (png.width - 1) / 2, y - (png.height - 1) / 2));
    }
  }
  assert.ok(whitePixels / (png.width * png.height) > 0.08);
  assert.ok(Math.abs((minX + maxX) / 2 - (png.width - 1) / 2) / png.width < 0.01, 'Center the complete white artwork horizontally');
  assert.ok(Math.abs((minY + maxY) / 2 - (png.height - 1) / 2) / png.height < 0.01, 'Center the complete white artwork vertically');
  assert.ok(maxRadius / png.width < 0.43, 'Keep visible blue space around every white tip under a circle mask');
  const adaptiveArtworkDiameterDp = 2 * maxRadius / png.width * 72;
  assert.ok(adaptiveArtworkDiameterDp <= 66, '108dp adaptive layer shrinks to a 72dp viewport and stays inside its 66dp safe zone');
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
  assert.ok(Math.abs(inset('Left') + inset('Right') - 1/3) < 1e-6);
  assert.ok(Math.abs(inset('Top') + inset('Bottom') - 1/3) < 1e-6);
  const png = PNG.sync.read(readFileSync(new URL('../assets/images/liflow-icon.png', import.meta.url)));
  let count=0, xSum=0, ySum=0, maxRadius=0;
  for (let y=0;y<png.height;y++) for(let x=0;x<png.width;x++) {
    const i=(y*png.width+x)*4;
    if (Math.min(...png.data.subarray(i,i+3)) > 235) {
      count++; xSum+=x; ySum+=y;
      maxRadius=Math.max(maxRadius,Math.hypot(inset('Left')+2/3*x/png.width-.5,inset('Top')+2/3*y/png.height-.5)*108);
    }
  }
  assert.ok(Math.abs(inset('Left')+2/3*xSum/count/png.width-.5)<.005, 'white visual mass is centered horizontally');
  assert.ok(Math.abs(inset('Top')+2/3*ySum/count/png.height-.5)<.005, 'white visual mass is centered vertically');
  assert.ok(maxRadius<33, 'all white tips remain in the Android safe circle');
  assert.ok(xml.includes('@mipmap/ic_launcher_foreground'));
  assert.ok(xml.includes('@color/iconBackground'));
  assert.ok(!xml.includes('ic_launcher_monochrome'));
});
