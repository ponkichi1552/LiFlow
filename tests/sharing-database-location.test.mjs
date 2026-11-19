import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as operations from '../src/features/sharing/operations.ts';
import * as privateCalendarNames from '../src/features/sharing/private-calendar/database-name.ts';

function fixture(platform = 'android') {
  const directory = platform === 'android' ? '/data/user/0/jp.test/files/SQLite' : 'file:///var/mobile/Containers/Data/Application/app/Documents/SQLite';
  let marker = null, registryPresent = false; const opens = [];
  const module = loadNativeModule('src/platform/sharing/database-location.ts', {
    'expo-file-system': { File: class { constructor(uri, name) { assert.ok(uri.startsWith('file:///'), 'FileSystem must receive an absolute file URI'); this.name = name; }
      get exists() { return this.name === 'sharing-index.db' ? registryPresent : marker !== null; }
      async text() { return JSON.stringify(marker); } } },
    'expo-sqlite': { defaultDatabaseDirectory: directory, async openDatabaseAsync(...args) { opens.push(args); return { name: args[0] }; } },
    'react-native': { Platform: { OS: platform } },
    '@noble/hashes/sha2.js': { sha256 }, '@noble/hashes/utils.js': { bytesToHex },
    '../../features/sharing/operations.ts': operations,
    '../../features/sharing/private-calendar/database-name.ts': privateCalendarNames,
  });
  const path = platform === 'android' ? '/data/user/0/jp.test/no_backup/LiFlowSharedSQLite' : '/var/mobile/Containers/Data/Application/app/Documents/SQLite/shared';
  return { module, directory, path, opens, set: (value) => { marker = value; }, addRegistry: () => { registryPresent = true; },
    ready: () => { marker = { policyVersion: 1, platform, databaseDirectory: path }; } };
}

test('startup can prepare an existing registry only in the validated backup-excluded location', async () => {
  for (const platform of ['ios', 'android']) {
    const h = fixture(platform);
    await assert.rejects(h.module.existingSharingRegistryDirectory('sharing-index.db'), /ビルド/);
    h.ready();
    assert.equal(await h.module.existingSharingRegistryDirectory('sharing-index.db'), undefined);
    h.addRegistry();
    assert.equal(await h.module.existingSharingRegistryDirectory('sharing-index.db'), `file://${h.path}`);
    h.set({ policyVersion: 1, platform, databaseDirectory: h.directory });
    await assert.rejects(h.module.existingSharingRegistryDirectory('sharing-index.db'));
    assert.equal(h.opens.length, 0);
  }
});

test('private Calendar Native files remain account-scoped and backup-excluded on both mobile OSes', async () => {
  const before = globalThis.__DEV__;
  try {
    for (const platform of ['ios', 'android']) {
      const h = fixture(platform);
      await assert.rejects(() => h.module.openPrivateCalendarDatabase('private-owner'), /ビルド/u); assert.equal(h.opens.length, 0);
      h.ready(); const own = await h.module.openPrivateCalendarDatabase('private-owner');
      const other = await h.module.openPrivateCalendarDatabase('another-owner');
      assert.equal(own.kind, 'private-calendar'); assert.equal(own.ownerUserId, 'private-owner'); assert.equal(own.filename, privateCalendarNames.privateCalendarDatabaseFilename('private-owner'));
      assert.notEqual(own.filename, other.filename); assert.notEqual(own.filename, h.module.sharingV2DatabaseFilename('private-owner', 'a-group'));
      assert.equal(h.opens[0][2], `file://${h.path}`); assert.deepEqual(h.opens[0][1], { useNewConnection: true });
      globalThis.__DEV__ = false; const count = h.opens.length;
      await assert.rejects(() => h.module.openPrivateCalendarDatabase('private-owner', true), /開発/u); assert.equal(h.opens.length, count);
      globalThis.__DEV__ = true; const qa = await h.module.openPrivateCalendarDatabase('private-owner', true);
      assert.notEqual(qa.filename, own.filename); assert.equal(qa.development, true);
    }
  } finally { globalThis.__DEV__ = before; }
});

test('shared databases require a confirmed native backup-excluded directory on both mobile OSes', async () => {
  for (const platform of ['ios', 'android']) {
    const h = fixture(platform); await assert.rejects(h.module.openSharingDatabase('user', 'group'), /ビルド/); assert.equal(h.opens.length, 0);
    h.ready(); await h.module.openSharingDatabase('user', 'group');
    assert.equal(h.opens[0][2], `file://${h.path}`); assert.deepEqual(h.opens[0][1], { useNewConnection: true });
    for (const patch of [{ policyVersion: 2 }, { platform: 'web' }, { databaseDirectory: h.directory },
      { databaseDirectory: '/tmp/shared' }, { unsafe: true }]) {
      h.set({ policyVersion: 1, platform, databaseDirectory: h.path, ...patch });
      await assert.rejects(h.module.openSharingDatabase('user', 'group'));
    }
    assert.equal(h.opens.length, 1);
  }
});

test('group SQLite filenames are stable, opaque and independent for each user and group', () => {
  const h = fixture(); const one = h.module.sharingDatabaseFilename('user-a', 'group-a');
  assert.match(one, /^group-[a-f0-9]{64}\.db$/); assert.equal(h.module.sharingDatabaseFilename('user-a', 'group-a'), one);
  assert.notEqual(h.module.sharingDatabaseFilename('user-b', 'group-a'), one);
  assert.notEqual(h.module.sharingDatabaseFilename('user-a', 'group-b'), one);
  assert.notEqual(h.module.sharingDatabaseFilename('user-a', 'group-a', 'rejoin-1'), one);
  assert.notEqual(h.module.sharingDatabaseFilename('user-a', 'group-a', 'rejoin-1'), h.module.sharingDatabaseFilename('user-a', 'group-a', 'rejoin-2'));
  assert.equal(h.module.sharingDatabaseFilename('user-a', 'group-a', undefined), one, 'pre-existing group paths must not change');
  assert.throws(() => h.module.sharingDatabaseFilename('../escape', 'group-a'));
});

test('native container aliases on Android 10 and iOS remain inside the same app and backup-excluded directory', () => {
  const android = fixture('android');
  assert.equal(android.module.validateSharingDatabaseLocation({ policyVersion: 1, platform: 'android',
    databaseDirectory: '/data/data/jp.test/no_backup/LiFlowSharedSQLite' }, android.directory, 'android'),
    'file:///data/data/jp.test/no_backup/LiFlowSharedSQLite');
  assert.throws(() => android.module.validateSharingDatabaseLocation({ policyVersion: 1, platform: 'android',
    databaseDirectory: '/data/user/10/jp.test/no_backup/LiFlowSharedSQLite' }, android.directory, 'android'));
  const ios = fixture('ios');
  assert.equal(ios.module.validateSharingDatabaseLocation({ policyVersion: 1, platform: 'ios',
    databaseDirectory: '/private' + ios.path }, ios.directory, 'ios'), 'file:///private' + ios.path);
});

test('v2 database paths cannot collide with legacy paths for any local generation and retain account isolation', async () => {
  for (const platform of ['ios', 'android']) {
    const h = fixture(platform); h.ready();
    const v1 = h.module.sharingDatabaseFilename('user', 'group'); const v2 = h.module.sharingV2DatabaseFilename('user', 'group');
    assert.match(v2, /^group-v2-[a-f0-9]{64}\.db$/u); assert.notEqual(v1, v2);
    for (const generation of [undefined, 'v2', 'group-v2', 'development-v2-preview', 'rejoin-1']) {
      assert.notEqual(h.module.sharingDatabaseFilename('user', 'group', generation), v2);
      assert.notEqual(h.module.sharingDatabaseFilename('user', 'group', generation), h.module.sharingV2DatabaseFilename('user', 'group', generation));
    }
    assert.notEqual(v2, h.module.sharingV2DatabaseFilename('another-user', 'group'));
    assert.notEqual(v2, h.module.sharingV2DatabaseFilename('user', 'another-group'));
    assert.notEqual(v2, h.module.sharingV2DatabaseFilename('user', 'group', 'rejoin-1'));
    await h.module.openSharingV2Database('user', 'group'); assert.deepEqual(h.opens, [[v2, { useNewConnection: true }, `file://${h.path}`]]);
    assert.throws(() => h.module.sharingV2DatabaseFilename('../escape', 'group'));
  }
});

test('v2 databases fail closed when native backup exclusion has not been confirmed', async () => {
  for (const platform of ['ios', 'android']) {
    const h = fixture(platform); await assert.rejects(h.module.openSharingV2Database('user', 'group'), /ビルド/u); assert.equal(h.opens.length, 0);
    h.ready(); h.set({ policyVersion: 1, platform, databaseDirectory: h.directory });
    await assert.rejects(h.module.openSharingV2Database('user', 'group')); assert.equal(h.opens.length, 0);
  }
});
