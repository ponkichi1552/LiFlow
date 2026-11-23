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

const lightPressColors = { primary: '#0D638B', tinted: '#EDF3FC', warning: '#F8EBE9' } as const;
const darkPressColors = { primary: '#44B7D1', tinted: '#254B59', warning: '#4C3038' } as const;

export function plannerPressColorsForScheme(scheme?: string | null) {
  return scheme === 'dark' ? darkPressColors : lightPressColors;
}
