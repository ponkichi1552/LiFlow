import './typescript-loader.mjs';
import { createDatabase } from './sqlite.mjs';
import { addDays, localDateFromDate } from '../../src/domain/scheduling/local-date.ts';
import { createV2PrivateTaskSource } from '../../src/features/sharing/v2-ui/private-overlay.ts';
const repository = await import('../../src/platform/storage/repository.ts');

export const privateToday = localDateFromDate(new Date());
/** Private UI scenarios need a usable same-day window regardless of the test runner's wall clock. */
export function pinPrivateFixtureTime(t) {
  const RealDate = Date, realNow = RealDate.now.bind(RealDate);
  const offset = RealDate.parse(`${privateToday}T12:00:00+09:00`) - realNow();
  function FixtureDate(...args) {
    if (!new.target) return new RealDate(realNow() + offset).toString();
    return Reflect.construct(RealDate, args.length ? args : [realNow() + offset], new.target);
  }
  // Keep elapsed wall time for backoff, queues and observation deadlines.
  t.mock.method(globalThis, 'Date', FixtureDate);
  t.mock.method(globalThis.Date, 'now', () => realNow() + offset);
}
export const privateRange = { from: addDays(privateToday, -14), through: addDays(privateToday, 14) };
export async function privateFixture({ commonHistory = false } = {}) {
  const f = createDatabase(); await repository.initializeLocalDatabase(f.database);
  const first = await repository.loadPlannerSnapshot(f.database); let chore = first.chores.find((item) => item.id === 'liflow-catalog-6.001');
  chore = { ...chore, name: '本人だけの床掃除', description: '非公開の手順です。', load: 'heavy', recommendedCycleDays: 7,
    windowRadiusDays: 2, maxShiftDays: 2, holidayPriority: false };
  await repository.updateChoreDefinition(f.database, chore);
  await repository.completeFirstSetup(f.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { date: addDays(privateToday, -7) } }, weatherLocation: null });
  await repository.loadPlannerSnapshot(f.database);
  let access = true; let changed = 0;
  const assertAccess = () => { if (!access) throw new Error('account changed'); };
  const source = createV2PrivateTaskSource({ ownerUserId: 'owner', assertAccess,
    ...(commonHistory ? { mirrorShared: (value, guard) => repository.mirrorSharedChoreCompletions(f.database, value, guard) } : {}),
    readSnapshot: async (instant) => ({ ownerUserId: 'owner', ...await repository.readPersonalPlannerOverlaySnapshot(f.database, instant) }),
    save: (command, guard) => repository.setPersonalDateTaskCompleted(f.database, command, guard), afterChange: () => { changed++; } });
  return { ...f, chore, source, changed: () => changed, stopAccess: () => { access = false; },
    read: (r = privateRange) => source.read(r, new Date()) };
}
