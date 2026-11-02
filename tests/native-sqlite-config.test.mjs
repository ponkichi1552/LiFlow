import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const configure = createRequire(import.meta.url)('../app.config.js');
const sqlite = (config = {}) => {
  const entry = configure({ config }).plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-sqlite');
  assert.ok(entry, 'native transaction connections need an explicit foreign-key default');
  return entry[1];
};
const foreignKeys = options => {
  for (const platform of ['android', 'ios']) {
    const flags = (options[platform]?.customBuildFlags ?? options.customBuildFlags).split(/\s+/u);
    assert.ok(flags.includes('-DSQLITE_DEFAULT_FOREIGN_KEYS=1'), platform);
    assert.ok(!flags.includes('-DSQLITE_DEFAULT_FOREIGN_KEYS=0'), platform);
  }
};

test('new native SQLite transaction connections enforce foreign keys on both operating systems', () => {
  foreignKeys(sqlite());
});

test('native SQLite safety defaults preserve encryption and platform-specific build options', () => {
  const options = sqlite({ plugins: [['expo-sqlite', { useSQLCipher: true, enableFTS: false,
    customBuildFlags: '-DSQLITE_ENABLE_STAT4=1',
    ios: { customBuildFlags: '-DSQLITE_DEFAULT_FOREIGN_KEYS=0 -DSQLITE_ENABLE_DBSTAT_VTAB=1' },
    android: { withSQLiteVecExtension: true } }]] });
  foreignKeys(options);
  assert.equal(options.useSQLCipher, true); assert.equal(options.enableFTS, false);
  assert.equal(options.android.withSQLiteVecExtension, true);
  assert.ok(options.customBuildFlags.includes('-DSQLITE_ENABLE_STAT4=1'));
  assert.ok(options.ios.customBuildFlags.includes('-DSQLITE_ENABLE_DBSTAT_VTAB=1'));
});
