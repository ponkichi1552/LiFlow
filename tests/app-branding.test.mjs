import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo;
const adaptive = config.android.adaptiveIcon;

function readIcon(asset) {
  return PNG.sync.read(readFileSync(new URL(`../${asset}`, import.meta.url)));
}

test('LiFlow uses the same app name and icon artwork on iOS and Android without changing app identity', () => {
  assert.equal(config.name, 'LiFlow');
  assert.equal(config.ios.icon.light, config.icon);
  assert.equal(config.ios.icon.dark, config.icon);
  assert.equal(config.android.icon, config.icon);
  assert.notEqual(adaptive.foregroundImage, config.icon, 'The adaptive layer needs transparent margins');
  assert.equal(adaptive.backgroundImage, undefined);
  assert.equal(adaptive.monochromeImage, undefined);
  assert.equal(config.ios.bundleIdentifier, 'jp.jphacks.tkb2633');
  assert.equal(config.android.package, 'jp.jphacks.tkb2633');
  assert.equal(config.scheme, 'houseworkplanner');
  assert.ok(config.plugins.includes('./plugins/with-liflow-launcher-icons'));
  const splash = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
  assert.equal(splash[1].image, './assets/images/liflow-icon.png');
  assert.equal(splash[1].dark.image, './assets/images/liflow-icon-dark.png');
});

function artworkBounds(png, background) {
  const { width, height, data } = png;
  const center = (width - 1) / 2;
  let left = width, right = -1, top = height, bottom = -1, maxRadius = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (background) {
        assert.equal(data[i + 3], 255, 'The iOS and legacy icon must be opaque');
        if (data[i] === background[0] && data[i + 1] === background[1] && data[i + 2] === background[2]) continue;
      } else if (data[i + 3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      maxRadius = Math.max(maxRadius, Math.hypot(x - center, y - center));
    }
  }
  assert.ok(right > left && bottom > top, 'The icon must contain visible artwork');
  return { left, top, right, bottom, maxRadius };
}

test('LiFlow shares the launcher drawing across the opaque icon and the Android adaptive safe circle', () => {
  const full = readIcon(config.icon);
  const layer = readIcon(adaptive.foregroundImage);
  for (const png of [full, layer]) {
    assert.equal(png.width, png.height);
    assert.ok(png.width >= 1024);
  }
  const background = Buffer.from(adaptive.backgroundColor.slice(1), 'hex');
  assert.deepEqual(full.data.subarray(0, 3), background);
  const artwork = artworkBounds(full, background);
  const foreground = artworkBounds(layer);
  assert.ok(artwork.maxRadius < full.width / 2, 'The entire drawing survives the legacy round mask');
  assert.ok(foreground.maxRadius * 108 / layer.width < 33, 'All visible foreground pixels stay in the safe circle');

  // Compare the same points in each drawing, allowing for resampling and antialiasing.
  function sample(png, bounds, u, v) {
    const x = Math.round(bounds.left + (bounds.right - bounds.left) * u);
    const y = Math.round(bounds.top + (bounds.bottom - bounds.top) * v);
    const i = (y * png.width + x) * 4;
    const opacity = png.data[i + 3] / 255;
    return Array.from(background, (color, c) => opacity * png.data[i + c] + (1 - opacity) * color);
  }
  const samples = 32;
  let difference = 0;
  for (let y = 0; y < samples; y++) {
    for (let x = 0; x < samples; x++) {
      const u = (x + 0.5) / samples, v = (y + 0.5) / samples;
      const ios = sample(full, artwork, u, v);
      const android = sample(layer, foreground, u, v);
      difference += ios.reduce((sum, value, c) => sum + Math.abs(value - android[c]), 0);
    }
  }
  assert.ok(difference / (samples * samples * 3) < 8, 'Both icons display the same drawing over the same background');
});

test('LiFlow launcher manifest selects standard and round resources and keeps existing attributes', () => {
  const plugin = require('../plugins/with-liflow-launcher-icons.js');
  const attributes = {
    'android:name': '.MainApplication',
    'android:label': '@string/app_name',
    'android:allowBackup': 'false',
    'android:icon': '@mipmap/liflow_launcher',
    'android:roundIcon': '@mipmap/liflow_launcher',
  };
  const manifest = { manifest: { application: [{ $: { ...attributes } }] } };
  const result = plugin.setLauncherManifest(manifest);
  assert.deepEqual(result.manifest.application[0].$, {
    ...attributes,
    'android:icon': '@mipmap/ic_launcher',
    'android:roundIcon': '@mipmap/ic_launcher_round',
  });
});
