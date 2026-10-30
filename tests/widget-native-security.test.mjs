import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const plugin = require('../plugins/with-android-widget-completion.js');
const { protectWidgetReceiver } = plugin;

test('Android widget completion receiver refuses external broadcasts while keeping framework update metadata and own PendingIntent interactions', async () => {
  for (const name of ['.NextChoreWidgetProvider', 'jp.jphacks.tkb2633.NextChoreWidgetProvider']) {
    const receiver = { $: { 'android:name': name, 'android:exported': 'true' }, 'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/next_chore_widget_info' } }] };
    const before = structuredClone(receiver); const other = { $: { 'android:name': '.UnrelatedReceiver', 'android:exported': 'true' } };
    const manifest = { manifest: { application: [{ receiver: [receiver, other] }] } };
    protectWidgetReceiver(manifest); assert.equal(receiver.$['android:exported'], 'false');
    receiver.$['android:exported'] = 'true';
    const configured = plugin({ name: 'LiFlow', slug: 'liflow' });
    await configured.mods.android.manifest({ ...configured, modRequest: { platform: 'android', modName: 'manifest' }, modResults: manifest });
    assert.equal(receiver.$['android:exported'], 'false', 'the real manifest mod must apply the boundary');
    assert.deepEqual(receiver['intent-filter'], before['intent-filter']); assert.deepEqual(receiver['meta-data'], before['meta-data']); assert.equal(other.$['android:exported'], 'true');
    protectWidgetReceiver(manifest); assert.equal(receiver.$['android:exported'], 'false');
  }
  assert.throws(() => protectWidgetReceiver({ manifest: { application: [{}] } }), /must exist/);
  const kotlin = readFileSync(new URL('../plugins/android/WidgetCompletionDatabase.kt', import.meta.url), 'utf8');
  assert.match(kotlin, /database\.beginTransaction\(\)/); assert.match(kotlin, /pending_status_revision/);
  assert.ok(JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo.plugins.includes('./plugins/with-android-widget-completion'));
});
