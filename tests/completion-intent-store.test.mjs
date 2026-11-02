import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureVault } from '../src/features/sharing/secure-vault.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

for (const platform of ['ios', 'android']) test(`${platform} completion intents use protected chunked storage and retain separate account and workspace generations`, async () => {
  const memory = new Map(); let ordinal = 0, fail = false;
  const native = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 4,
    getItemAsync: async (key, options) => { assert.equal(options.keychainService, 'jp.jphacks.tkb2633.completion-intents'); return memory.get(key) ?? null; },
    setItemAsync: async (key, value, options) => { assert.equal(options.keychainAccessible, 4); if (fail) throw new Error('protected storage unavailable'); memory.set(key, value); },
    deleteItemAsync: async key => { memory.delete(key); },
  };
  const { protectedCompletionIntentStore } = loadNativeModule('src/platform/storage/completion-intent-store.ts', {
    'expo-secure-store': native, 'expo-crypto': { getRandomBytesAsync: async length => new Uint8Array(length).fill(++ordinal) },
    '../../features/sharing/secure-vault.ts': { createSecureVault },
  });
  const capture = target => { if (!target || typeof target.chore !== 'string') throw new Error('invalid target'); return { chore: target.chore }; };
  const first = protectedCompletionIntentStore('user-a/group-a/generation-1', capture);
  const otherUser = protectedCompletionIntentStore('user-b/group-a/generation-1', capture);
  const rejoined = protectedCompletionIntentStore('user-a/group-a/generation-2', capture);
  const item = { id: 'intent-1', key: 'bath', target: { chore: '浴室' }, completed: true, createdAt: '2026-11-02T04:00:00Z', status: 'queued' };
  await first.save([item]); assert.deepEqual(await first.load(), [item]);
  assert.deepEqual(await otherUser.load(), []); assert.deepEqual(await rejoined.load(), []);
  const returned = await first.load(); returned[0].target.chore = 'changed'; assert.deepEqual(await first.load(), [item]);
  fail = true; await assert.rejects(first.save([{ ...item, completed: false }]), /unavailable/); fail = false;
  assert.deepEqual(await first.load(), [item], 'a failed replacement keeps the last complete protected manifest');
  await first.save([]); assert.deepEqual(await first.load(), []);
  await assert.rejects(first.save([{ ...item, target: { chore: 17 } }]), /invalid target/);
});
