import { useCallback } from 'react';
import { useColorScheme } from 'react-native';
import { wasteTypeColor } from './type-appearance';

/** One appearance-aware foreground for onboarding, editors, personal and group collections. */
export function useWasteTypeColor() {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  return useCallback((label: string) => wasteTypeColor(label, appearance), [appearance]);
}
