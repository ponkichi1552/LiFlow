import values from './planner-color-values.js';

export type PlannerColorName = keyof typeof values;
export type PlannerColorScheme = 'light' | 'dark';
export type PlannerColors = Readonly<Record<PlannerColorName, string>>;

function colorsFor(scheme: PlannerColorScheme): PlannerColors {
  return Object.freeze(Object.fromEntries(Object.entries(values).map(([name, colors]) => [name, colors[scheme]]))) as PlannerColors;
}

export const plannerLightColors = colorsFor('light');
export const plannerDarkColors = colorsFor('dark');

export function plannerColorsForScheme(scheme?: string | null): PlannerColors {
  return scheme === 'dark' ? plannerDarkColors : plannerLightColors;
}
