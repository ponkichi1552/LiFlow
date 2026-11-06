import { proposePersonalRelocation } from '../v2/personal-relocation.ts';
import type { PersonalRelocation, PersonalRelocationInput } from '../v2/personal-relocation.ts';
import { privatePlannerAllowedWindows, snapshotSavedPrivatePlannerPreferences, privatePlannerPreferenceValues } from './preferences.ts';
import type { SavedPrivatePlannerPreferences } from './preferences.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { sharedDateAtTime, sharedLocalDate } from '../group-clock.ts';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';

/** Only the authenticated person's explicit saved bands can authorize a private proposal. No shared write occurs here. */
export function proposePrivatePlannerRelocation(ownerUserId: string, preferences: SavedPrivatePlannerPreferences | null,
  input: Omit<PersonalRelocationInput, 'allowedWindows'>): PersonalRelocation {
  assertSharedIdentifier(ownerUserId);
  if (!preferences) return proposePersonalRelocation({ ...input, allowedWindows: [] });
  const own = snapshotSavedPrivatePlannerPreferences(preferences, ownerUserId);
  parseLocalDate(input.windowStart); parseLocalDate(input.windowEnd);
  if (input.windowStart > input.windowEnd) throw new Error('個人家事の実施期間を確認してください。');
  const start = sharedDateAtTime(input.windowStart, 0, 0, input.timeZone);
  const end = sharedDateAtTime(addDays(input.windowEnd, 1), 0, 0, input.timeZone).getTime();
  const allowed = privatePlannerAllowedWindows(privatePlannerPreferenceValues(own), sharedLocalDate(start, own.timeZone), sharedLocalDate(new Date(end - 1), own.timeZone));
  // Bands use their explicit region; the chore's original civil window and same-day priority stay in its own region.
  const result = proposePersonalRelocation({ ...input, allowedWindows: allowed.unresolvedDates.length ? [] : allowed.windows });
  return result.kind === 'needsReview' && result.reason === 'missingAllowedTimes' && allowed.unresolvedDates.length
    ? { kind: 'needsReview', reason: 'ambiguousAllowedTimes' } : result;
}
