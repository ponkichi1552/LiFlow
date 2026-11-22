const eventLink = /^(https:\/\/(?:calendar\.google\.com|www\.google\.com)(?::443)?\/calendar\/(?:u\/[0-9]+\/)?(?:r\/)?(?:event|eventedit))(?:\/([a-z0-9_=-]+))?\/?(?:\?([^#]*))?$/iu;
export const googleCalendarHome = 'https://calendar.google.com/calendar/u/0/r';

export function googleCalendarEventLink(value: unknown): string | undefined {
  // A strict match also keeps the result the same across native URL parsers.
  if (typeof value !== 'string' || /[^!-~]|\\/u.test(value)) return undefined;
  const match = eventLink.exec(value);
  if (!match) return undefined;
  const [, base, pathId, query] = match;
  const params = new URLSearchParams(query);
  if (params.getAll('action').some(action => action.toUpperCase() !== 'VIEW')) return undefined;
  const ids = params.getAll('eid');
  if (pathId) return ids.length ? undefined : `${base}/${pathId}`;
  if (ids.length !== 1 || !/^[a-z0-9_+=/-]+$/iu.test(ids[0])) return undefined;
  return `${base}?eid=${encodeURIComponent(ids[0])}`;
}
