import { DynamicColorIOS, Platform, PlatformColor } from 'react-native';
import type { ColorValue } from 'react-native';
import values from './planner-color-values.js';
import type { PlannerColorName } from './planner-theme';

// Native color values update even in already-mounted, memoized StyleSheets.
// Android resources come from with-liflow-theme, including values-night.
export const palette = Object.fromEntries(Object.entries(values).map(([name, colors]) => [name,
  Platform.OS === 'ios' ? DynamicColorIOS(colors) : PlatformColor(`@color/liflow_${name.toLowerCase()}`),
])) as Readonly<Record<PlannerColorName, ColorValue>>;
