import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import { createSecureVault } from '../../features/sharing/secure-vault.ts';
import type { CompletionIntent, CompletionIntentStore } from '../../features/planner/completion-intents.ts';

const options: SecureStore.SecureStoreOptions = {
  keychainService: 'jp.jphacks.tkb2633.completion-intents',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
// Keep unsigned requests outside SQLite's long business transaction. SecureStore
// authenticates them; copying or editing a database cannot forge a new request
// that the app would later sign. The existing vault publishes complete chunks.
const vault = createSecureVault({
  get: key => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: key => SecureStore.deleteItemAsync(key, options),
}, getRandomBytesAsync);

export function protectedCompletionIntentStore<T>(scope: string, capture: (value: T) => T): CompletionIntentStore<T> {
  if (!scope || scope.length > 2000) throw new Error('操作する保存先を確認できません。');
  const key = `completion-intents:v1:${scope}`;
  return {
    async load() {
      const saved = await vault.getItem(key); if (saved === null) return [];
      const value = JSON.parse(saved) as { version?: unknown; scope?: unknown; requests?: unknown };
      if (value?.version !== 1 || value.scope !== scope || !Array.isArray(value.requests) || value.requests.length > 128) {
        throw new Error('保存待ちの家事を確認できません。');
      }
      return value.requests.map((item: CompletionIntent<T>) => ({ ...item, target: capture(item.target) }));
    },
    async save(requests) {
      if (requests.length > 128) throw new Error('保存待ちの家事が多すぎます。');
      await vault.setItem(key, JSON.stringify({ version: 1, scope,
        requests: requests.map(item => ({ ...item, target: capture(item.target) })) }));
    },
  };
}
