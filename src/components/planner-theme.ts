import values from './planner-color-values.js';

export type PlannerColorName = keyof typeof values;
export type PlannerColorScheme = 'light' | 'dark';
export type PlannerColors = Readonly<Record<PlannerColorName, string>>;

export function plannerColorsForScheme(scheme?: string | null): PlannerColors {
  const key = scheme === 'dark' ? 'dark' : 'light';
  return Object.fromEntries(Object.entries(values).map(([name, colors]) => [name, colors[key]])) as PlannerColors;
}

export const plannerLightColors = plannerColorsForScheme('light');
export const plannerDarkColors = plannerColorsForScheme('dark');
