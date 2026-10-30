import { plannerLightColors } from './planner-theme.ts';
import { createTypography } from './planner-text-roles.ts';

// Domain/screen tests use plain light values; Metro selects the Native counterpart.
export const typography = createTypography(plannerLightColors);
