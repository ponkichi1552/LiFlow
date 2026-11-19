import { StyleSheet, useColorScheme } from 'react-native';
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native';
import { palette } from './planner-colors';
import { plannerColorsForScheme } from './planner-theme';

const roles = ['border', 'inputBorder', 'accent', 'muted', 'warning'] as const;
type Sheet = Record<string, ViewStyle | TextStyle | ImageStyle>;
const lightStyles = new WeakMap<Sheet, Sheet>();
const darkStyles = new WeakMap<Sheet, Sheet>();

/** Recycled native border layers receive concrete colors after an appearance change. */
export function usePlannerBorderStyles<T extends Sheet>(source: T): T {
  const scheme = useColorScheme();
  // Static StyleSheets can be reused by every visible row of the same appearance.
  const cache = scheme === 'dark' ? darkStyles : lightStyles;
  const retained = cache.get(source);
  if (retained) return retained as T;
  const colors = plannerColorsForScheme(scheme);
  const resolved = Object.fromEntries(Object.entries(source).map(([name, value]) => {
    const style = StyleSheet.flatten(value) ?? {};
    return [name, Object.fromEntries(Object.entries(style).map(([key, color]) => {
      if (!/^border.*Color$/.test(key) && !(key === 'backgroundColor' && color === palette.border)) return [key, color];
      const role = roles.find(role => color === palette[role]);
      return [key, role ? colors[role] : color];
    }))];
  })) as T;
  cache.set(source, resolved);
  return resolved;
}
