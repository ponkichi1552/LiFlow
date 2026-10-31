import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as policy from '../src/features/google-sync/account-binding.ts';
const repository = await import('../src/platform/storage/repository.ts');
import { classifyGoogleSyncFailure } from '../src/features/google-sync/error-classification.ts';

test('bound Google accounts reject a different subject before any lookup or persistence', async () => {
  await assert.rejects(policy.verifyGoogleAccountBinding({ boundSubject: 'account-a', currentSubject: 'account-b', legacyTaskListIds: [],
    listOwnedTaskListIds: async () => assert.fail('must not query another account'), persistSubject: async () => assert.fail('must not overwrite binding') }), policy.GoogleAccountMismatchError);
  assert.equal(classifyGoogleSyncFailure({ code: 'google_account_mismatch' }, new Date()).kind, 'authRequired');
});

test('legacy Google mappings bind only after every saved list is confirmed to belong to that account', async () => {
  const saved = [];
  const port = { currentSubject: 'account-a', legacyTaskListIds: ['list-a', 'list-b'],
    listOwnedTaskListIds: async () => ['list-a', 'list-b'], persistSubject: async (value) => { saved.push(value); } };
  await policy.verifyGoogleAccountBinding(port); assert.deepEqual(saved, ['account-a']);
  saved.length = 0;
  await assert.rejects(policy.verifyGoogleAccountBinding({ ...port, listOwnedTaskListIds: async () => ['different-list'] }), policy.GoogleAccountMismatchError);
  assert.deepEqual(saved, []);
});

test('a new workspace binds independently without reading another workspaces Google lists', async () => {
  let saved;
  await policy.verifyGoogleAccountBinding({ currentSubject: 'account-b', legacyTaskListIds: [],
    listOwnedTaskListIds: async () => assert.fail('new workspace needs no migration lookup'), persistSubject: async (value) => { saved = value; } });
  assert.equal(saved, 'account-b');
});

test('Google account bindings survive stale state saves and reject an attempted replacement atomically', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const state = { householdId: repository.LOCAL_HOUSEHOLD_ID, enabled: true, taskListId: 'original-list',
      status: 'idle', retryCount: 0, updatedAt: '2026-10-27T00:00:00Z' };
    await repository.saveGoogleSyncState(h.database, state); await repository.bindGoogleSyncAccount(h.database, 'account-a');
    await repository.saveGoogleSyncState(h.database, { ...state, status: 'syncing' });
    assert.equal((await repository.loadGoogleSyncState(h.database)).accountSubject, 'account-a');
    const before = h.connection.prepare('SELECT * FROM google_sync_state').get();
    await assert.rejects(repository.saveGoogleSyncState(h.database, { ...state, accountSubject: 'account-b', taskListId: 'wrong-list', enabled: false }), policy.GoogleAccountMismatchError);
    assert.deepEqual(h.connection.prepare('SELECT * FROM google_sync_state').get(), before);
  } finally { h.connection.close(); }
});

test('schema 18 adds a nullable local Google subject without replacing task mappings or user settings', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.saveGoogleSyncState(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, enabled: false,
      taskListId: 'legacy-list', status: 'retryPending', retryCount: 3, updatedAt: '2026-10-26T00:00:00Z' });
    const settings = h.connection.prepare('SELECT * FROM household_settings').all();
    h.connection.exec('ALTER TABLE google_sync_state DROP COLUMN account_subject; PRAGMA user_version = 17;');
    const before = h.connection.prepare('SELECT * FROM google_sync_state').get();
    await repository.initializeLocalDatabase(h.database);
    const { account_subject, ...after } = h.connection.prepare('SELECT * FROM google_sync_state').get();
    assert.equal(account_subject, null); assert.deepEqual(after, { ...before });
    assert.deepEqual(h.connection.prepare('SELECT * FROM household_settings').all(), settings);
    assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 21);
  } finally { h.connection.close(); }
});

async function fixture({ subject = 'account-a', bound, lists = ['legacy-list'] } = {}) {
  const h = createDatabase(); await repository.initializeLocalDatabase(h.database);
  await repository.saveGoogleSyncState(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, enabled: true,
    taskListId: 'legacy-list', ...(bound ? { accountSubject: bound } : {}), status: 'idle', retryCount: 0, updatedAt: '2026-10-27T00:00:00Z' });
  let current = subject; const calls = [];
  class Required extends Error {}
  const module = loadNativeModule('src/platform/google-tasks/bound-session.ts', {
    '../storage/repository': repository,
    '../../features/google-sync/account-binding.ts': policy,
    './google-tasks-api': { createGoogleTasksApi: () => ({ async listTaskLists() { calls.push('lists'); return lists.map((id) => ({ id })); } }) },
    './google-sign-in-gateway': { GoogleSignInRequiredError: Required, getCurrentGoogleSubject: async () => current,
      async getGoogleTasksAccessToken(expected) { assert.equal(expected, current); calls.push('tasks'); return 'synthetic-tasks-token'; },
      async getGoogleCalendarAccessToken(expected) { assert.equal(expected, current); calls.push('calendar'); return 'synthetic-calendar-token'; } },
  });
  return { ...h, module, calls, changeSubject: (value) => { current = value; } };
}

test('both Google token purposes verify workspace ownership and a bound mismatch cannot fetch another accounts calendar', async () => {
  for (const purpose of ['tasks', 'calendar']) {
    const h = await fixture({ subject: 'account-b', bound: 'account-a' });
    try {
      await assert.rejects(h.module.getBoundGoogleAccessToken(h.database, purpose), policy.GoogleAccountMismatchError);
      assert.deepEqual(h.calls, []);
    } finally { h.connection.close(); }
  }
});

test('legacy account verification is performed once and does not repeat task-list reads on later syncs', async () => {
  const h = await fixture();
  try {
    assert.equal(await h.module.getBoundGoogleAccessToken(h.database, 'tasks'), 'synthetic-tasks-token');
    assert.equal((await repository.loadGoogleSyncState(h.database)).accountSubject, 'account-a');
    await h.module.getBoundGoogleAccessToken(h.database, 'calendar');
    assert.deepEqual(h.calls, ['tasks', 'lists', 'calendar']);
  } finally { h.connection.close(); }
});

test('legacy ownership failure preserves saved Google list IDs and never binds the new account', async () => {
  const h = await fixture({ subject: 'account-b', lists: ['unrelated-list'] });
  try {
    await assert.rejects(h.module.getBoundGoogleAccessToken(h.database, 'tasks'), policy.GoogleAccountMismatchError);
    const state = await repository.loadGoogleSyncState(h.database);
    assert.equal(state.accountSubject, undefined); assert.equal(state.taskListId, 'legacy-list');
  } finally { h.connection.close(); }
});
