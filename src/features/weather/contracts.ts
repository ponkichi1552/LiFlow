import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { EntityId, LocalDate, WeatherLocation } from '@/domain/shared/types';

export interface DailyWeather {
  date: LocalDate;
  weatherCode: number | null;
  precipitationProbability: number | null;
  /** Legacy daily-provider port, in millimeters; the active MET path uses UTC intervals. */
  precipitationMm: number | null;
}

export interface WeatherForecastQuery<TLocation = WeatherLocation> {
  householdId: EntityId;
  location: TLocation;
  from: LocalDate;
  through: LocalDate;
}

export interface WeatherForecastProvider<TLocation = WeatherLocation, TForecast = readonly DailyWeather[]> {
  fetchForecast(query: WeatherForecastQuery<TLocation>): Promise<TForecast>;
}

export interface WeatherScheduleAdjustment<TData = unknown> {
  scheduleEntryId: EntityId;
  data: TData;
}

export interface WeatherAdjustmentPolicy<TForecast = readonly DailyWeather[], TData = unknown> {
  proposeAdjustments(input: {
    forecast: TForecast;
    schedule: readonly ChoreScheduleEntry[];
  }): readonly WeatherScheduleAdjustment<TData>[];
}

/** Weather changes are opt-in through the user's selected region in Settings. */
export const WEATHER_ADJUSTMENTS_ENABLED = true;
export const WEATHER_FORECAST_CACHE_TTL_MS = 15 * 60 * 1000;
