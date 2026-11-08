import { DynamicColorIOS, Platform, PlatformColor } from 'react-native';
import type { ColorValue } from 'react-native';
import values from './planner-color-values.js';
import type { PlannerColorName } from './planner-theme';

// Native semantic colors; recycled border layers also resolve concrete values
// with usePlannerBorderStyles. Android resources include values-night.
export const palette = Object.fromEntries(Object.entries(values).map(([name, colors]) => [name,
  Platform.OS === 'ios' ? DynamicColorIOS(colors) : PlatformColor(`@color/liflow_${name.toLowerCase()}`),
])) as Readonly<Record<PlannerColorName, ColorValue>>;
