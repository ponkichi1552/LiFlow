import { categoryColor as originalCategoryColor } from '../../domain/calendar/events.ts';
import { plannerColorsForScheme } from '../../components/planner-theme.ts';

const channels = (color: string) => color.slice(1).match(/../g)!.map(value => parseInt(value, 16));
const hex = (rgb: number[]) => '#' + rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
const mix = (front: string, back: string, amount: number) => hex(channels(front).map((value, i) => value * amount + channels(back)[i] * (1 - amount)));
const luminance = (color: string) => channels(color).map(value => {
  const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
}).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
export const calendarColorContrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

/** Small month labels keep the classification hue while reading more clearly on a dark surface. */
export const calendarMonthTitleColor = (foreground: string, dark: boolean) => dark ? mix('#FFFFFF', foreground, .25) : foreground;

/** Display adaptation never changes a saved category or its Google color. */
export function calendarDisplayColor(color: string, dark: boolean) {
  const theme = plannerColorsForScheme(dark ? 'dark' : 'light');
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const values = channels(color);
    if (!dark && values.every(value => value >= 245)) return theme.muted;
    if (dark && values.every(value => value <= 16)) return theme.ink;
  }
  return originalCategoryColor(color, dark);
}

export function calendarEventAppearance(color: string, dark: boolean) {
  const theme = plannerColorsForScheme(dark ? 'dark' : 'light');
  const accent = calendarDisplayColor(color, dark);
  const backgroundColor = mix(accent, theme.surface, dark ? .19 : .13);
  let foregroundColor = accent;
  for (let amount = .1; calendarColorContrast(foregroundColor, backgroundColor) < 4.5 && amount <= 1; amount += .1) {
    foregroundColor = mix(dark ? '#FFFFFF' : '#000000', accent, amount);
  }
  return { accent, backgroundColor, foregroundColor };
}
