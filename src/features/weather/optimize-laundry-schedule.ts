import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
} from '@/domain/chores/types';
import type { EntityId, LocalDate, WeatherLocation } from '@/domain/shared/types';
import type { ExternalAvailabilityByDate, ScheduleSettings } from '@/domain/scheduling/contracts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import {
  applyLaundryWeatherAdjustments,
  eligibleLaundryEntries,
  LaundryWeatherAdjustmentPolicy,
} from './laundry-policy.ts';
import type { DailyWeather, WeatherForecastProvider } from './contracts';
import { WEATHER_ADJUSTMENTS_ENABLED } from './contracts.ts';

export type WeatherScheduleOutcome = 'disabled' | 'current' | 'adjusted' | 'unavailable';

export interface WeatherOptimizedSchedule {
  schedule: ChoreScheduleEntry[];
  outcome: WeatherScheduleOutcome;
  adjustmentCount: number;
}

export interface LaundryWeatherOptimizationInput {
  householdId: EntityId;
  today: LocalDate;
  location?: WeatherLocation;
  chores: readonly ChoreDefinition[];
  completions: readonly ChoreCompletion[];
  dependencies: readonly ChoreDependency[];
  settings: ScheduleSettings;
  externalAvailabilityByDate?: ExternalAvailabilityByDate;
  schedule: readonly ChoreScheduleEntry[];
}


/** Adds weather as an optional optimization; any failure returns the rule-based schedule unchanged. */
export async function optimizeLaundryScheduleForWeather(
  input: LaundryWeatherOptimizationInput,
  provider?: WeatherForecastProvider<WeatherLocation, readonly DailyWeather[]>,
): Promise<WeatherOptimizedSchedule> {
  if (!WEATHER_ADJUSTMENTS_ENABLED || !input.location) {
    return { schedule: [...input.schedule], outcome: 'disabled', adjustmentCount: 0 };
  }

  const forecastThrough = addDays(input.today, 6);
  if (!eligibleLaundryEntries(input.schedule, input).length) return { schedule: [...input.schedule], outcome: 'current', adjustmentCount: 0 };
  // Historical schedule fixtures can inject their daily provider. Production
  // personal planning uses the durable regional MET path, never this old client.
  if (!provider) return { schedule: [...input.schedule], outcome: 'unavailable', adjustmentCount: 0 };

  try {
    const forecast = await provider.fetchForecast({
      householdId: input.householdId,
      location: input.location,
      from: input.today,
      through: forecastThrough,
    });
    const dates = new Set(forecast.map((day) => day.date));
    for (let offset = 0; offset < 7; offset += 1) {
      if (!dates.has(addDays(input.today, offset))) {
        return { schedule: [...input.schedule], outcome: 'unavailable', adjustmentCount: 0 };
      }
    }
    if (!forecast.some((day) => day.weatherCode !== null && day.precipitationProbability !== null && day.precipitationMm !== null)) {
      return { schedule: [...input.schedule], outcome: 'unavailable', adjustmentCount: 0 };
    }

    const policy = new LaundryWeatherAdjustmentPolicy({
      today: input.today,
      chores: input.chores,
      completions: input.completions,
      dependencies: input.dependencies,
      settings: input.settings,
      externalAvailabilityByDate: input.externalAvailabilityByDate,
    });
    const adjustments = policy.proposeAdjustments({ forecast, schedule: input.schedule });
    return {
      schedule: applyLaundryWeatherAdjustments(input.schedule, adjustments),
      outcome: adjustments.length > 0 ? 'adjusted' : 'current',
      adjustmentCount: adjustments.length,
    };
  } catch {
    return { schedule: [...input.schedule], outcome: 'unavailable', adjustmentCount: 0 };
  }
}
