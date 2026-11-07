import type { AdaptivePlacementDay } from '../../domain/scheduling/adaptive/placement';
import type { MetForecast } from '../../../server/appliance-care-api/src/weather/forecast.mjs';
/** Compare provider facts per civil day without changing their original interval order. */
export function weatherChangeDays(days: readonly AdaptivePlacementDay[], before: MetForecast | undefined, after: MetForecast, fingerprint: (value: unknown) => string) {
  const sorted = [...days].sort((a, b) => a.bounds.start - b.bounds.start);
  const index = (forecast: MetForecast | undefined) => {
    const result = new Map<string, MetForecast['intervals']>();
    for (const row of forecast?.intervals ?? []) {
      const start = row.start; const end = row.end;
      let low = 0; let high = sorted.length;
      while (low < high) { const mid = (low + high) >>> 1; if (sorted[mid].bounds.end <= start) low = mid + 1; else high = mid; }
      for (let i = low; i < sorted.length && sorted[i].bounds.start < end; i++) {
        const day = sorted[i]; const list = result.get(day.date) ?? []; list.push(row); result.set(day.date, list);
      }
    }
    return result;
  };
  const prior = index(before); const next = index(after);
  return days.filter(day => fingerprint(prior.get(day.date) ?? []) !== fingerprint(next.get(day.date) ?? [])).map(day => day.date);
}
