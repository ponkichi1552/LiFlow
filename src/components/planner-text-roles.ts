import type { ColorValue } from 'react-native';

// Shared phone text roles. Native semantic colors also update in mounted StyleSheets.
// A bare role must not fall back to React Native's black text on a dark surface.
export const createTypography = (palette: { ink: ColorValue; muted: ColorValue }) => ({
  title: { fontSize: 28, lineHeight: 36, color: palette.ink },
  section: { fontSize: 22, lineHeight: 30, color: palette.ink },
  subheading: { fontSize: 19, lineHeight: 27, color: palette.ink },
  body: { fontSize: 17, lineHeight: 26, color: palette.ink },
  control: { fontSize: 18, lineHeight: 26, color: palette.ink },
  label: { fontSize: 16, lineHeight: 24, color: palette.ink },
  caption: { fontSize: 14, lineHeight: 21, color: palette.muted },
  small: { fontSize: 12, lineHeight: 18, color: palette.muted },
  // Dense calendar and tab labels are shared exceptions, not per-page font guesses.
  calendarDate: { fontSize: 18, lineHeight: 24, color: palette.ink },
  calendarLabel: { fontSize: 14, lineHeight: 19, color: palette.muted },
  tab: { fontSize: 14, lineHeight: 20, color: palette.muted },
} as const);
