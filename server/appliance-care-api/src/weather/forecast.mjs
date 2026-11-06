/** Shared mobile/server interpretation. Missing values remain unknown, never dry. */
export const MET_TRANSFORM_VERSION = 1;
const HOUR = 3_600_000;
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid MET forecast time');
  const stamp = Date.parse(value);
  if (new Date(stamp).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('Invalid MET calendar time');
  return stamp;
}
function nullable(value, maximum = 1e6) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error('Invalid MET forecast measurement');
  return value;
}
export function parseMetForecast(body) {
  const generatedAt = body?.properties?.meta?.updated_at;
  instant(generatedAt);
  const units = body.properties.meta.units;
  if (units?.precipitation_amount !== undefined && units.precipitation_amount !== 'mm') throw new Error('Unsupported MET precipitation unit');
  if (units?.probability_of_precipitation !== undefined && units.probability_of_precipitation !== '%') throw new Error('Unsupported MET probability unit');
  const series = body.properties.timeseries;
  if (!Array.isArray(series) || !series.length || series.length > 400) throw new Error('Invalid MET forecast series');
  const intervals = []; let previous = -Infinity;
  for (const row of series) {
    const start = instant(row?.time);
    if (start <= previous || !row.data || typeof row.data !== 'object') throw new Error('Unordered MET forecast series');
    previous = start;
    for (const hours of [1, 6, 12]) {
      const period = row.data[`next_${hours}_hours`];
      if (period === undefined) continue;
      if (!period || typeof period !== 'object') throw new Error('Invalid MET forecast interval');
      const symbol = period.summary?.symbol_code ?? null;
      if (symbol !== null && (typeof symbol !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(symbol))) throw new Error('Invalid MET weather symbol');
      intervals.push({ start, end: start + hours * HOUR, precipitationMm: nullable(period.details?.precipitation_amount),
        precipitationProbability: nullable(period.details?.probability_of_precipitation, 100), symbol });
    }
  }
  if (!intervals.length) throw new Error('MET forecast has no supported time intervals');
  return { transformVersion: MET_TRANSFORM_VERSION, generatedAt, from: new Date(intervals[0].start).toISOString(),
    through: new Date(Math.max(...intervals.map(row => row.end))).toISOString(), intervals };
}
export function validMetForecast(value) {
  if (value?.transformVersion !== MET_TRANSFORM_VERSION || !Array.isArray(value.intervals)
    || !value.intervals.length || value.intervals.length > 1200) return false;
  try {
    const from = instant(value.from); const through = instant(value.through); instant(value.generatedAt);
    if (through <= from || through - from > 16 * 24 * HOUR) return false;
    return value.intervals.every(row => Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end)
      && [HOUR, 6 * HOUR, 12 * HOUR].includes(row.end - row.start) && row.start >= from && row.end <= through
      && (row.precipitationMm === null || nullable(row.precipitationMm) !== null)
      && (row.precipitationProbability === null || nullable(row.precipitationProbability, 100) !== null)
      && (row.symbol === null || typeof row.symbol === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(row.symbol)));
  } catch { return false; }
}
/** Finest non-overlapping complete cover. Coarse totals are never added to
 * hourly totals over the same time, or proportionally invented for a half hour. */
export function metWeatherForWindow(forecast, start, end) {
  if (!validMetForecast(forecast)) return unknown();
  return weatherForCheckedWindow(forecast, start, end);
}
export function createMetWeatherEvaluator(forecast) {
  if (!validMetForecast(forecast)) return null;
  const checked = { ...forecast, intervals: forecast.intervals.map(row => ({ ...row })) };
  return { boundaries: [...new Set(checked.intervals.flatMap(row => [row.start, row.end]))].sort((a, b) => a - b),
    evaluate: (start, end) => weatherForCheckedWindow(checked, start, end) };
}
function weatherForCheckedWindow(forecast, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return unknown();
  const intervals = forecast.intervals.filter(row => row.start < end && row.end > start);
  const byStart = new Map();
  for (const row of intervals) { const list = byStart.get(row.start) ?? []; list.push(row); byStart.set(row.start, list); }
  const memo = new Map();
  const cover = cursor => {
    if (cursor >= end) return { cost: 0, rows: [] };
    if (memo.has(cursor)) return memo.get(cursor);
    const options = cursor === start ? intervals.filter(row => row.start <= cursor && row.end > cursor) : byStart.get(cursor) ?? [];
    let best = null;
    for (const row of options) {
      const next = cover(row.end); if (!next) continue;
      const cost = ((row.end - row.start) / HOUR) ** 2 + next.cost;
      if (!best || cost < best.cost) best = { cost, rows: [row, ...next.rows] };
    }
    memo.set(cursor, best); return best;
  };
  const result = cover(start); if (!result) return unknown();
  const mm = result.rows.every(row => row.precipitationMm !== null) ? result.rows.reduce((sum, row) => sum + row.precipitationMm, 0) : null;
  const probability = result.rows.every(row => row.precipitationProbability !== null)
    ? Math.max(...result.rows.map(row => row.precipitationProbability)) : null;
  const symbols = result.rows.map(row => row.symbol);
  const known = mm !== null && symbols.every(symbol => symbol !== null);
  const benign = symbols.every(symbol => /^(?:clearsky|fair|partlycloudy|cloudy)(?:_(?:day|night|polartwilight))?$/u.test(symbol ?? ''));
  return { known, suitable: known ? mm <= 0.5 && (probability === null || probability <= 30) && benign : null,
    precipitationMm: mm, precipitationProbability: probability, symbols, coveredIntervals: result.rows.length };
}
function unknown() { return { known: false, suitable: null, precipitationMm: null, precipitationProbability: null, symbols: [], coveredIntervals: 0 }; }
export function weatherCacheFreshness(cache, now = Date.now()) {
  const checked = Date.parse(cache?.checkedAt); const generated = Date.parse(cache?.forecast?.generatedAt);
  if (!Number.isFinite(checked) || !Number.isFinite(generated) || checked > now || generated > now) return { placement: false, display: false };
  const measured = cache.forecast.intervals?.some(row => row.precipitationMm !== null && row.symbol !== null) === true;
  return { placement: measured && now - checked <= 36 * HOUR && now - generated <= 48 * HOUR,
    display: now - checked <= 72 * HOUR && now - generated <= 72 * HOUR };
}
