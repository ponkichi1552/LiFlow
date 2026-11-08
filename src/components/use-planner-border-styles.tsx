import { useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native';
import { palette } from './planner-colors';
import { plannerColorsForScheme } from './planner-theme';

const roles = ['border', 'inputBorder', 'accent', 'muted', 'warning'] as const;

/** Recycled native border layers receive concrete colors after an appearance change. */
export function usePlannerBorderStyles<T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(source: T): T {
  const scheme = useColorScheme();
  return useMemo(() => {
    const colors = plannerColorsForScheme(scheme);
    return Object.fromEntries(Object.entries(source).map(([name, value]) => {
      const style = StyleSheet.flatten(value) ?? {};
      return [name, Object.fromEntries(Object.entries(style).map(([key, color]) => {
        if (!/^border.*Color$/.test(key) && !(key === 'backgroundColor' && color === palette.border)) return [key, color];
        const role = roles.find(role => color === palette[role]);
        return [key, role ? colors[role] : color];
      }))];
    })) as T;
  }, [source, scheme]);
}
