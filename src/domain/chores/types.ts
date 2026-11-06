import type { CalendarCountColors, CalendarCountDisplayMode, EntityId, ISODateTime, LocalDate, WeatherLocation } from '@/domain/shared/types';

export type ChoreLoad = 'light' | 'normal' | 'heavy';
export type FrequencyMode = 'frequent' | 'balanced' | 'relaxed';
export type LaundryDryingPreference = 'indoors' | 'outdoors' | 'either';
export type ChoreStatus = 'initialPending' | 'scheduled' | 'inWindow' | 'overdue';

export interface ChoreSourceEvidence {
  url: string;
  pageOrSection?: string;
}

export interface ApplianceCareSource {
  manufacturer: string;
  productName: string;
  modelNumber: string;
  productUrl?: string;
  manualUrl: string;
  analyzedAt: ISODateTime;
  evidence: ChoreSourceEvidence[];
}

export interface ChoreTrivia {
  id: string;
  title: string;
  body: string;
}

export interface ChoreProcedureSection {
  title: string;
  steps: string[];
}

export interface ChoreDefinition {
  id: EntityId;
  householdId: EntityId;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  /** User override. When unset, the selected frequency mode supplies the cycle. */
  recommendedCycleDays?: number;
  /** User override for an appliance-care task. Kept separate from the maker interval. */
  userIntervalDays?: number;
  /** Manufacturer-stated starting interval. User edits are stored separately above. */
  manufacturerRecommendedIntervalDays?: number;
  /** Conditions stated by the manufacturer when no fixed cycle is specified. */
  manufacturerRecommendedConditions?: string[];
  /** No fixed cadence was supplied (product, usage, season or municipal conditions), and none was chosen by the user. */
  requiresCycleSelection?: boolean;
  /** Non-periodic modes have no numeric entry; never substitute zero or one day. */
  frequencyDaysByMode: Partial<Record<FrequencyMode, number>>;
  /** Explicit new-catalog identity; no legacy-name matching or migration heuristic. */
  personalRecipeId?: string;
  personalSchedulingKind?: 'personal' | 'seasonal';
  cadenceLabelsByMode?: Record<FrequencyMode, string>;
  /** Absent means the adaptive period supplies its default width. */
  userWindowRadiusDays?: number;
  /** Immutable creation defaults, without duplicating guide text or importing the full catalog for a reset. */
  personalScheduleDefaults?: Pick<ChoreDefinition, 'frequencyDaysByMode' | 'load' | 'windowRadiusDays' | 'maxShiftDays' | 'holidayPriority' | 'everyday' | 'requiresCycleSelection' | 'laundryDryingPreference'>;
  /** Explains provisional or condition-based intervals in the current recurring model. */
  schedulingNotes?: string;
  /** Radius around the target date; 1 means target ±1 day. */
  windowRadiusDays: number;
  /** Maximum movement from the cycle date when holidays or load require it. */
  maxShiftDays: number;
  load: ChoreLoad;
  holidayPriority: boolean;
  /** The default cycle is daily in every frequency mode; individual overrides still take precedence. */
  everyday: boolean;
  locationOrAppliance?: string;
  laundryDryingPreference?: LaundryDryingPreference;
  instructions: string[];
  /** Grouped procedures for jobs with different ways to handle removable parts. */
  procedureSections?: ChoreProcedureSection[];
  tools: string[];
  cautions: string[];
  trivia?: ChoreTrivia[];
  sourceNotes?: string[];
  /** Retired seeded chores stay available to render their existing completion history. */
  archived?: boolean;
  estimatedMinutes?: number;
  /** Provenance for appliance-care chores created from a reviewed official manual analysis. */
  applianceCareSource?: ApplianceCareSource;
  /** Stable parent appliance id. */
  applianceId?: EntityId;
  /** Exact maintenance task name from the reviewed manufacturer analysis. */
  applianceTaskName?: string;
}

export interface ChoreAssignment {
  choreId: EntityId;
  memberIds: EntityId[];
}

/** A dependency link; ordering and conflict behavior are supplied by a policy later. */
export interface ChoreDependency {
  id: EntityId;
  predecessorChoreId: EntityId;
  successorChoreId: EntityId;
  policyData?: unknown;
}

export interface ChoreScheduleEntry {
  id: EntityId;
  householdId: EntityId;
  choreId: EntityId;
  cycleBaseDate: LocalDate;
  windowStart: LocalDate;
  windowEnd: LocalDate;
  suggestedDate: LocalDate;
  status: ChoreStatus;
  assignedMemberIds: EntityId[];
  seasonalWork?: 'winterStorage' | 'summerStorage';
  overdueDays?: number;
  overdueCycles?: number;
}

export interface ChoreCompletion {
  id: EntityId;
  householdId: EntityId;
  choreId: EntityId;
  completedAt: ISODateTime;
  /** Freeze the recording day; a later timezone change never rewrites source history. */
  completedLocalDate?: LocalDate;
  completedTimeZone?: string;
  /** Exact immutable completion action; a stale Undo cannot cancel a subsequent redo. */
  adaptiveOperationId?: string;
  seasonalWork?: 'winterStorage' | 'summerStorage';
  completedByMemberId?: EntityId;
  outcome: 'completed' | 'incomplete';
  source?: 'inApp' | 'notification' | 'widget' | 'googleTasks';
  scheduleEntryId?: EntityId;
  /** The date this occurrence was scheduled for, kept even if completion regenerates the schedule. */
  scheduledDate?: LocalDate;
  scheduledWindowStart?: LocalDate;
  scheduledWindowEnd?: LocalDate;
  completionNote?: 'completedNow' | 'alreadyDone';
  estimatedDate?: boolean;
}

export interface ChoreState {
  choreId: EntityId;
  lastCompletedDate?: LocalDate;
  lastCompletedEstimated: boolean;
  initialPending: boolean;
  initialScheduledDate?: LocalDate;
  unknownReason?: 'unknown' | 'skipped';
}

export interface HouseholdPlannerSettings {
  householdId: EntityId;
  frequencyMode: FrequencyMode;
  restDays: number[];
  heavyDailyLimit: number;
  normalDailyLimit: number;
  notificationHour: number;
  notificationMinute: number;
  notificationsEnabled: boolean;
  setupCompleted: boolean;
  calendarCountColors: CalendarCountColors;
  calendarCountDisplayMode: CalendarCountDisplayMode;
  /** Region selected from user-entered text for weather forecasts. */
  weatherLocation?: WeatherLocation;
}
