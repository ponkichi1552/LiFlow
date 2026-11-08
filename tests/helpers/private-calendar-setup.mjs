import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { createDatabase } from './sqlite.mjs';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { createSecureVault } from '../../src/features/sharing/secure-vault.ts';
import { createPrivateCalendarSecretStore, readPrivateCalendarProtectedDeviceState, assertPrivateCalendarProtectedAuthority } from '../../src/features/sharing/private-calendar/secret-store.ts';
import { privateCalendarDatabaseFilename } from '../../src/features/sharing/private-calendar/database-name.ts';
import { createPrivateCalendarExclusiveStorage } from '../../src/platform/storage/private-calendar-store.ts';
import { createPrivateCalendarRootSetupStorage } from '../../src/platform/storage/private-calendar-root-setup.ts';
import { createPrivateCalendarFirstDeviceSetup } from '../../src/features/sharing/private-calendar/first-device-setup.ts';
import { createPrivateCalendarAuthorityIntentStorage } from '../../src/platform/storage/private-calendar-authority-intents.ts';
import { createPrivateCalendarKeyOutbox } from '../../src/platform/storage/private-calendar-key-outbox.ts';
import { createPrivateCalendarPairingStorage } from '../../src/platform/storage/private-calendar-pairing.ts';
import { createPrivateCalendarCacheStorage } from '../../src/platform/storage/private-calendar-cache.ts';
import { createPrivateCalendarConnectionStorage } from '../../src/platform/storage/private-calendar-connections.ts';

/** Real SQLite and the actual protected-vault implementation; no network or personal database. */
export function privateCalendarSetupFixture(t, options = {}) {
  const userId = options.userId ?? 'root-setup-owner'; const values = options.values ?? new Map();
  const state = options.state ?? { currentUser: userId, generations: 0, afterVaultWrite: null, afterCommit: null };
  const raw = createDatabase(options.path); t.after(() => raw.connection.close());
  const database = options.decorate ? options.decorate(raw.database, state) : raw.database;
  const exclusive = createPrivateCalendarExclusiveStorage({ kind: 'private-calendar', ownerUserId: userId,
    filename: privateCalendarDatabaseFilename(userId, true), development: true, database }).exclusive;
  const gateway = { ...crypto, async randomBytes(length) { state.generations++; if (state.beforeRandom) await state.beforeRandom(length); return crypto.randomBytes(length); } };
  const vault = createSecureVault({ get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } }, crypto.randomBytes);
  const assertOwner = expected => { assert.equal(state.currentUser, expected, 'account changed'); };
  const guardedExclusive = async (uid, work) => { const result = await exclusive(uid, work); if (state.afterCommit) await state.afterCommit(); return result; };
  const secrets = createPrivateCalendarSecretStore({ crypto: gateway, vault: { getItem: key => vault.getItem(key), setItem: async (...args) => {
    await vault.setItem(...args); if (state.afterVaultWrite) await state.afterVaultWrite();
  } }, assertOwner, exclusive: guardedExclusive });
  const readProtected = async () => readPrivateCalendarProtectedDeviceState(await vault.getItem(`private-calendar-state:${userId}`), userId);
  const roots = createPrivateCalendarRootSetupStorage({ ownerUserId: userId, crypto: gateway, assertOwner, exclusive: guardedExclusive, readProtected });
  const changes = createPrivateCalendarAuthorityIntentStorage({ ownerUserId: userId, assertOwner, exclusive: guardedExclusive, readProtected });
  const keyOutbox = createPrivateCalendarKeyOutbox({ ownerUserId: userId, crypto: gateway, assertOwner, exclusive: guardedExclusive, readProtected });
  const pairing = createPrivateCalendarPairingStorage({ ownerUserId: userId, crypto: gateway, assertOwner, exclusive: guardedExclusive, readProtected, vault });
  const cache = createPrivateCalendarCacheStorage({ ownerUserId: userId, crypto: gateway, assertOwner, exclusive: guardedExclusive,
    async assertAuthority(authority, requireMain) { assertOwner(userId); assertPrivateCalendarProtectedAuthority(await vault.getItem(`private-calendar-state:${userId}`), userId, authority, requireMain); } });
  const controller = cloud => createPrivateCalendarFirstDeviceSetup({ userId, secrets, intents: roots, cloud });
  const connections = createPrivateCalendarConnectionStorage({ ownerUserId: userId, assertOwner, exclusive: guardedExclusive, vault });
  return { ...raw, database, userId, values, state, gateway, vault, secrets, roots, changes, keyOutbox, pairing, connections, cache, controller, readProtected, exclusive: guardedExclusive };
}
