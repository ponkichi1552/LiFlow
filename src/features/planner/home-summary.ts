import moment from 'moment-timezone';

export function homeSummary(total: number, done: number) {
  return {
    showProgress: total > 0,
    percent: total > 0 ? done >= total ? 100 : Math.min(99, Math.max(0, Math.round(done / total * 100))) : 0,
  };
}

/** Refresh the displayed date at the next local midnight, including DST. */
export function nextHomeClockDelay(now: Date, timeZone?: string): number {
  const clock = timeZone && moment.tz.zone(timeZone) ? moment.tz(now, timeZone) : moment(now);
  const next = clock.clone().add(1, 'day').startOf('day');
  return Math.max(1, next.valueOf() - now.getTime() + 50);
}
