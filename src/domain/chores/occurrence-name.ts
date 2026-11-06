import type { ChoreScheduleEntry } from './types';

/** Distinct seasonal work must be recognisable even when both rows share one guide. */
export function choreOccurrenceName(name: string, work?: ChoreScheduleEntry['seasonalWork']): string {
  if (!work) return name;
  const clothing = work === 'winterStorage' ? '冬物' : '夏物';
  return name === '季節衣類のしまい洗い・収納' ? `${clothing}のしまい洗い・収納` : `${name}・${clothing}`;
}
