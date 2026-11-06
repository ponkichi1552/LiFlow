import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const plugin = require('../plugins/with-android-widget-completion.js');
const { protectWidgetReceiver } = plugin;

test('Android widget write-only SQLite calls never contain row-returning statements', () => {
  const kotlin = readFileSync(new URL('../plugins/android/WidgetCompletionDatabase.kt', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    const statements = [...kotlin.matchAll(/database\.execSQL\(\s*("""|")([\s\S]*?)\1/gu)].map(match => match[2]);
    assert.ok(statements.length > 0);
    for (const sql of statements) {
      assert.deepEqual(db.prepare(sql).columns(), [], 'Android execSQL rejects a statement that returns rows, including a PRAGMA setter');
      if (/^CREATE TABLE/iu.test(sql)) db.exec(sql);
    }
  } finally { db.close(); }
});

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
  assert.match(kotlin, /database\.beginTransaction\(\)/);
  assert.match(kotlin, /INSERT INTO native_widget_completion_intents/);
  assert.doesNotMatch(kotlin, /(?:INSERT INTO|UPDATE|DELETE FROM) (?:chore_completions|chore_state|google_task_links)/);
  for (const field of ['widgetAccountScope', 'subscriptionEnforced', 'accessUntil', 'contentUntil', 'publishedAtMs', 'displayDate']) assert.ok(kotlin.includes(field));
  const provider = readFileSync(new URL('../plugins/with-android-widget-completion.js', import.meta.url), 'utf8');
  assert.match(provider, /val pending = goAsync\(\)/); assert.match(provider, /inputs\.execute/); assert.match(provider, /pending\.finish\(\)/);
  assert.ok(JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo.plugins.includes('./plugins/with-android-widget-completion'));
});
