/** Display-only breaks keep long Latin tokens from leaving a mostly empty first line. */
export function calendarMonthTitleText(title: string, wrap = false) {
  const text = title.replace(/\s+/gu, ' ');
  // Break ASCII runs only: combining marks, emoji and ZWJ sequences stay intact.
  return wrap ? text.replace(/([A-Za-z0-9])(?=[A-Za-z0-9])/gu, '$1\u200b') : text;
}
