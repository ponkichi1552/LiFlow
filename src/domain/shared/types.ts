export type EntityId = string;
export type LocalDate = `${number}-${number}-${number}`;
export type ISODateTime = string;

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

/** Coordinates selected from a user-entered region through place search. */
export interface WeatherLocation extends GeoCoordinates {
  municipalityId?: string;
  region: string;
  displayName: string;
}

export interface CalendarCountColors {
  low: string;
  medium: string;
  high: string;
}

/** Legacy stored values remain readable; current screens render dots only. */
export type CalendarCountDisplayMode = 'bar' | 'dots';

/** Monday = 1 through Sunday = 7, independent of the device locale. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Household {
  id: EntityId;
  name: string;
  createdAt: ISODateTime;
}

export interface HouseholdMember {
  id: EntityId;
  householdId: EntityId;
  displayName: string;
}
