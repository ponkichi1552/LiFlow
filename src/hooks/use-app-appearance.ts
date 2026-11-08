import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { createAppearanceStore } from '../features/settings/appearance-store';

const store = createAppearanceStore(Storage, value => Appearance.setColorScheme(value === 'system' ? 'auto' : value));
export const initializeAppAppearance = store.initialize;
export function useAppAppearance() {
  return { preference: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot), set: store.set };
}
