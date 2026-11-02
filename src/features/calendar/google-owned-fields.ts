/** Only fields LiFlow owns participate in conflict detection. Other Google fields survive PATCH. */
export function googleOwnedFields(value: Record<string, unknown>): string {
  const date = (raw: unknown) => {
    const row = raw as { date?: string; dateTime?: string; timeZone?: string } | undefined;
    return row?.date ? { date: row.date } : row?.dateTime ? { instant: Date.parse(row.dateTime),
      ...(Array.isArray(value.recurrence) && value.recurrence.length ? { zone: row.timeZone ?? 'UTC' } : {}) } : null;
  };
  const recurrence = (Array.isArray(value.recurrence) ? value.recurrence : []).map(rule => {
    if (typeof rule !== 'string' || !rule.startsWith('RRULE:')) return rule;
    const parts = new Map(rule.slice(6).split(';').map((part: string) => { const [key, contents] = part.split('='); return [key, contents?.split(',').sort().join(',')]; }));
    if (!parts.has('INTERVAL')) parts.set('INTERVAL', '1');
    // WKST has no effect without a multi-week BYDAY rule.
    if (!parts.has('BYDAY') || Number(parts.get('INTERVAL')) === 1) parts.delete('WKST');
    else if (!parts.has('WKST')) parts.set('WKST', 'MO');
    return [...parts].sort(([a], [b]) => a.localeCompare(b));
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value.status === 'cancelled') return JSON.stringify({ deleted: true });
  return JSON.stringify({ title: value.summary ?? '', location: value.location ?? '', notes: value.description ?? '',
    start: date(value.start), end: date(value.end), transparency: value.transparency ?? 'opaque', recurrence });
}
