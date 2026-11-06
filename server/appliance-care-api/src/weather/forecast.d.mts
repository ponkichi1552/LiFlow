export interface MetWeatherInterval { start: number; end: number; precipitationMm: number | null; precipitationProbability: number | null; symbol: string | null }
export interface MetForecast { transformVersion: number; generatedAt: string; from: string; through: string; intervals: MetWeatherInterval[] }
export const MET_TRANSFORM_VERSION: number;
export function parseMetForecast(value: unknown): MetForecast;
export function validMetForecast(value: unknown): value is MetForecast;
export function metWeatherForWindow(forecast: unknown, start: number, end: number): { known: boolean; suitable: boolean | null; precipitationMm: number | null; precipitationProbability: number | null; symbols: (string | null)[]; coveredIntervals: number };
export function createMetWeatherEvaluator(forecast: unknown): { boundaries: number[]; evaluate(start: number, end: number): ReturnType<typeof metWeatherForWindow> } | null;
export function weatherCacheFreshness(cache: { checkedAt: string; forecast: MetForecast } | null | undefined, now?: number): { placement: boolean; display: boolean };
