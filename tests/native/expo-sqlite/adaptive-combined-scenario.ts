import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate, Weekday } from '../../../src/domain/shared/types';
import type { CalendarEvent } from '../../../src/domain/calendar/events';
import type { V2CommonPlan } from '../../../src/features/sharing/v2/common-plan';
import type { AdaptivePersonalOperation, AdaptivePersonalPlanning } from '../../../src/platform/storage/adaptive-personal-chores';
import { createPersonalChoreDefinitions } from '../../../src/domain/chores/personal-catalog';
import { addDays } from '../../../src/domain/scheduling/local-date';
import { sharedDocumentDigest } from '../../../src/features/sharing/crypto';
import { prepareAdaptivePlacementInput } from '../../../src/features/planner/adaptive-input';
import { planPersonalAdaptiveRounds } from '../../../src/features/planner/adaptive-rounds';
import { sharedAdaptiveLoad } from '../../../src/features/planner/shared-adaptive-load';
import { parseMetForecast } from '../../../server/appliance-care-api/src/weather/forecast.mjs';
import { withIsolatedSqliteTransaction } from '../../../src/platform/storage/isolated-transaction';
import { initializeAdaptivePersonalSchemaInside, initializeAdaptivePersonalChoreInside, readAdaptivePersonalInside,
  applyAdaptivePersonalOperationInside, replanAdaptivePersonalInside } from '../../../src/platform/storage/adaptive-personal-chores';

const choreId = 'native-combined-laundry';
const owner = 'native-test-owner';
const fingerprint = sharedDocumentDigest;
const require = (value: unknown, reason: string): void => { if (!value) throw new Error(reason); };

/** Synthetic, already-authorized shared projection. Authority/crypto are tested separately.
 * Only the fields consumed by the production load projector are needed here. */
function commonProjection(date: LocalDate): V2CommonPlan {
  const chore = { ...createPersonalChoreDefinitions('native-test').find(row => row.estimatedMinutes === 30)!,
    id: 'native-shared-cleaning', name: 'Native shared cleaning', enabled: true, archived: false, estimatedMinutes: 30, load: 'normal' as const };
  return { groupId: 'native-test-group', initialized: true, sourceHash: 'synthetic-verified-projection', planHash: 'synthetic-common-plan',
    members: [{ userId: owner, displayName: 'Test owner', active: true }, { userId: 'native-other', displayName: 'Test other', active: true }],
    chores: [chore], history: [], occurrences: [{ choreId: chore.id, historical: false, activeInPeriod: true, assigneeIds: [],
      subjects: [{ id: 'native-shared-round', required: true, completed: false, virtuallyConsumed: false, cooldownSuppressed: false,
        subjectUserId: null, formalDate: { kind: 'automatic' }, suggestedDate: date }] }] } as unknown as V2CommonPlan;
}

export async function combinedScenarioProof(database: SQLiteDatabase) {
  const view = await readAdaptivePersonalInside(database, choreId);
  const count = await database.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM personal_adaptive_actions');
  return { projectionDigest: fingerprint(view), actionCount: count?.count ?? -1 };
}

/** Uses only a new disposable database supplied by the separate test app. No network or real account. */
export async function runCombinedAdaptiveScenario(database: SQLiteDatabase) {
  const checks: string[] = [];
  const catalogChore = createPersonalChoreDefinitions('native-test').find(row => row.name === '衣類・タオルの洗濯');
  require(catalogChore, 'production-laundry-recipe-missing');
  const chore = { ...catalogChore!, id: choreId, enabled: true, estimatedMinutes: 30, load: 'normal' as const,
    laundryDryingPreference: 'outdoors' as const };
  let today: LocalDate = '2026-01-01';
  let revision = 0;
  let fixedLoads: ReturnType<typeof sharedAdaptiveLoad>['loads'] = [];
  let forecast: ReturnType<typeof parseMetForecast> | undefined;
  let events: CalendarEvent[] = [];
  const planning = (guard = () => {}): AdaptivePersonalPlanning => {
    const now = `${today}T08:00:00+09:00`;
    const geometry = prepareAdaptivePlacementInput({ from: today, through: addDays(today, 180), timeZone: 'Asia/Tokyo',
      preferences: { restDays: [], maximumMinutes: 30, heavyLimit: 1, normalLimit: 1, dayOverrides: [],
        allowedBands: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1 as Weekday, startMinute: 540, endMinute: 600 })) },
      events, exceptions: [], ...(forecast ? { weatherForecast: forecast } : {}), fingerprint });
    return { today, now, inputRevision: `native-${++revision}`, assertInputsCurrent: guard,
      plan({ roundId, state, previous, trigger }) {
        return planPersonalAdaptiveRounds({ requests: [{ roundId, state, previous, trigger, chore }], geometry,
          ownerId: owner, today, now: Date.parse(now), fixedLoads, fingerprint }).get(roundId)!;
      } };
  };
  await withIsolatedSqliteTransaction(database, async tx => {
    await initializeAdaptivePersonalSchemaInside(tx);
    await initializeAdaptivePersonalChoreInside(tx, { choreId, kind: 'personal', mode: 'balanced', enabled: true, fixedDays: null,
      initialDays: { frequent: 7, balanced: 14, relaxed: 28 }, version: 'native-combined-v1', planningAnchorDate: '2025-12-18' }, planning(), fingerprint);
  });
  let latest: AdaptivePersonalOperation | undefined;
  for (const [i, date] of (['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'] as LocalDate[]).entries()) {
    today = date;
    const view = await readAdaptivePersonalInside(database, choreId);
    require(view?.plan && view.planRevision, 'durable-round-missing');
    latest = { operationId: `native-done-${i}`, completionId: `native-completion-${i}`, type: 'complete',
      recordedAt: `${date}T08:00:00+09:00`, roundId: view!.plan!.id, planRevision: view!.planRevision!, date, timeZone: 'Asia/Tokyo', origin: 'personal' };
    const operation = latest;
    await withIsolatedSqliteTransaction(database, tx => applyAdaptivePersonalOperationInside(tx, choreId, operation, planning(), fingerprint));
    const after = await readAdaptivePersonalInside(database, choreId);
    if (i < 3) require(after?.state.model?.method === 'median' && after.state.model.days === 14, 'learned-before-three-intervals');
  }
  const learned = await readAdaptivePersonalInside(database, choreId);
  require(learned?.state.validIntervalCount === 3 && learned.state.model?.method === 'median' && learned.state.model.days === 28,
    'genuine-learning-did-not-use-three-intervals');
  const before = await combinedScenarioProof(database);
  require(before.actionCount === 4, 'fabricated-or-duplicate-history');
  checks.push('genuine-history-three-interval-learning');

  today = '2026-04-20';
  await withIsolatedSqliteTransaction(database, tx => replanAdaptivePersonalInside(tx, choreId, planning(), fingerprint));
  const baseline = await readAdaptivePersonalInside(database, choreId);
  require(baseline?.plan?.recommendedDate === '2026-04-23', 'learned-baseline-date');
  const common = commonProjection('2026-04-23'); const commonBefore = fingerprint(common);
  fixedLoads = sharedAdaptiveLoad(common, owner, today, 'Asia/Tokyo', []).loads;
  const otherLoads = sharedAdaptiveLoad(common, 'native-other', today, 'Asia/Tokyo', []).loads;
  require(fixedLoads.length === 1 && otherLoads.length === 1, 'unassigned-shared-load-not-reserved-for-both-members');
  checks.push('unassigned-shared-load-reserved-without-learning');
  events = [{ id: 'native-private-busy', revision: 1, title: 'Synthetic busy interval', location: '', notes: '', startDate: '2026-04-21',
    endDate: '2026-04-21', startMinute: 540, endMinute: 600, allDay: false, timeZone: 'Asia/Tokyo', recurrence: 'none',
    untilDate: null, categoryId: 'test', birthday: false, blocksTime: true }];
  const stamp = Date.parse('2026-04-20T00:00:00Z');
  forecast = parseMetForecast({ properties: { meta: { updated_at: new Date(stamp).toISOString(), units: { precipitation_amount: 'mm' } },
    timeseries: Array.from({ length: 10 * 24 }, (_, i) => {
      const time = stamp + i * 3_600_000; const rain = new Date(time + 9 * 3_600_000).toISOString().startsWith('2026-04-22');
      return { time: new Date(time).toISOString(), data: { next_1_hours: { summary: { symbol_code: rain ? 'rain' : 'clearsky_day' },
        details: { precipitation_amount: rain ? 1 : 0 } } } };
    }) } });
  await withIsolatedSqliteTransaction(database, tx => replanAdaptivePersonalInside(tx, choreId, planning(), fingerprint));
  const combined = await readAdaptivePersonalInside(database, choreId);
  require(combined?.plan?.recommendedDate === '2026-04-24' && combined.plan.slot !== null, 'combined-rain-busy-shared-load-placement');
  require(combined?.plan?.id === baseline?.plan?.id && fingerprint(combined?.state.model) === fingerprint(learned?.state.model), 'replan-changed-round-or-learned-period');
  require(fingerprint(common) === commonBefore && (await combinedScenarioProof(database)).actionCount === 4, 'replan-mutated-common-or-history');
  checks.push('calendar-rain-shared-load-combined-reallocation');

  const stable = await combinedScenarioProof(database); let guards = 0; const stale = new Error('synthetic-input-changed'); let refused = false;
  try {
    await withIsolatedSqliteTransaction(database, tx => applyAdaptivePersonalOperationInside(tx, choreId,
      { operationId: 'native-stale-settings', type: 'settings', fixedDays: 21, recordedAt: planning().now },
      planning(() => { if (++guards === 2) throw stale; }), fingerprint));
  } catch (cause) { if (cause !== stale) throw cause; refused = true; }
  require(refused && fingerprint(await combinedScenarioProof(database)) === fingerprint(stable), 'stale-input-transaction-not-rolled-back');
  checks.push('late-input-change-atomic-rollback');

  await withIsolatedSqliteTransaction(database, tx => applyAdaptivePersonalOperationInside(tx, choreId,
    { operationId: 'native-later-settings', type: 'settings', fixedDays: 21, recordedAt: `${today}T08:00:00+09:00` }, planning(), fingerprint));
  require(latest?.type === 'complete', 'latest-operation-missing');
  const done = latest! as Extract<AdaptivePersonalOperation, { type: 'complete' }>;
  await withIsolatedSqliteTransaction(database, tx => applyAdaptivePersonalOperationInside(tx, choreId,
    { operationId: 'native-undo-last', type: 'undo', completionId: done.completionId, targetOperationId: done.operationId,
      recordedAt: `${today}T08:00:00+09:00` }, planning(), fingerprint));
  const undone = await readAdaptivePersonalInside(database, choreId);
  require(undone?.state.policy.fixedDays === 21 && undone.state.model?.method === 'median' && undone.state.model.days === 21
    && undone.state.lastCompletedDate === '2026-02-26', 'undo-overwrote-later-setting-or-kept-undone-completion');
  checks.push('undo-preserves-later-explicit-setting');
  const afterUndo = await combinedScenarioProof(database);
  await withIsolatedSqliteTransaction(database, tx => applyAdaptivePersonalOperationInside(tx, choreId, done, planning(), fingerprint));
  require(fingerprint(await combinedScenarioProof(database)) === fingerprint(afterUndo), 'completion-replay-after-undo-mutated-state');
  checks.push('completion-replay-after-undo-is-idempotent');
  return { checks, proof: afterUndo, learnedDays: 28, baselineDate: baseline!.plan!.recommendedDate,
    combinedDate: combined!.plan!.recommendedDate, sharedProjectionUnchanged: fingerprint(common) === commonBefore,
    syntheticInputOnly: true, networkUsed: false };
}
