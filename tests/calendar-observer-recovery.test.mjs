import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
const { subscribeLocalCalendar, notifyCalendarSyncChanged } = await import('../src/platform/storage/calendar-events.ts');
import { retainCalendarInputs } from '../src/features/calendar/observed-snapshot.ts';

test('committed changes cross connections of the same SQLite file and never different files or anonymous databases', () => {
  const a = { databasePath: '/app/current/housework.db' }, b = { databasePath: '/app/current/housework.db' };
  const other = { databasePath: '/app/other/housework.db' }, memory = {}, memory2 = {};
  const seen = []; const stops = [[a,'a'],[other,'other'],[memory,'memory']].map(([db,label]) => subscribeLocalCalendar(db, kind => seen.push([label,kind])));
  try { notifyCalendarSyncChanged(b); assert.deepEqual(seen, [['a','sync']]); notifyCalendarSyncChanged(memory2); assert.equal(seen.length,1); }
  finally { stops.forEach(stop => stop()); }
  notifyCalendarSyncChanged(b); assert.equal(seen.length,1);
});

test('a draft-only update does not serialize identical saved input arrays', () => {
  const events = [{ toJSON() { throw new Error('unnecessary serialization'); } }];
  const value = { events, exceptions: [], categories: [], draft: null };
  assert.equal(retainCalendarInputs(value, { ...value, draft: {} }).events, events);
});

test('draft notifications after an unchanged full refresh do not repeatedly serialize saved calendar events', async () => {
  let changed; let serializations = 0;
  const empty = { events: [], categories: [], exceptions: [], draft: null, drafts: [] };
  const screen = screenHarness('tests/fixtures/calendar-observer-screen.tsx', {
    database: {}, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
        readLocalCalendar: async () => ({ ...empty, events: [{ title: 'Saved', toJSON() { serializations++; return { title: this.title }; } }] }),
        readLocalCalendarDrafts: async () => ({ draft: null, drafts: [] }),
        subscribeLocalCalendar: (_database, callback) => { changed = callback; return () => {}; } },
      './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
      '@/hooks/use-planner-data': { usePlannerData: () => ({ waitForInitialRead: async () => {} }) },
    },
  });
  try {
    await screen.flush(); await screen.press('refresh'); await screen.flush(); serializations = 0;
    for (let index = 0; index < 10; index++) { changed('drafts'); await screen.flush(); }
    assert.match(screen.text(), /Saved/);
    assert.equal(serializations, 0, 'typing a draft must not serialize unchanged saved events after a routine refresh');
  } finally { screen.unmount(); }
});

test('a queued full refresh survives a failed read and persistent failure cannot spin', async () => {
  let reads = 0, rejectFirst, changed; const empty = { events: [], categories: [], exceptions: [], draft: null, drafts: [] };
  const options = { database: {}, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
    '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
      readLocalCalendar: async () => { if (++reads === 1) return new Promise((_,reject) => { rejectFirst=reject; }); return { ...empty, events: [{ title:'Recovered' }] }; },
      readLocalCalendarDrafts: async () => assert.fail('queued full refresh cannot become draft-only'),
      subscribeLocalCalendar: (_db,fn) => { changed=fn; return () => {}; } },
    './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
    '@/hooks/use-planner-data': { usePlannerData: () => ({ waitForInitialRead: async () => {} }) },
  } };
  const screen = screenHarness('tests/fixtures/calendar-observer-screen.tsx', options);
  try { await screen.flush(); changed('events'); rejectFirst(new Error('temporary failure')); await screen.flush(); assert.equal(reads,2); assert.match(screen.text(),/Recovered/); }
  finally { screen.unmount(); }
});

test('bounded calendar history follows the latest viewport through an in-flight full read', async () => {
  const empty = { events: [], categories: [], exceptions: [], draft: null, drafts: [] };
  class HistoryLimit extends Error {}
  let rejectFull; let resolveFirstBounded; let binding; const rangedReads = [];
  const pendingFull = new Promise((_resolve, reject) => { rejectFull = reject; });
  const pendingFirstBounded = new Promise(resolve => { resolveFirstBounded = resolve; });
  const largeDatabase = {};
  const large = screenHarness('tests/helpers/local-calendar-observer-host.tsx', { exportName: 'LocalCalendarObserverHost', database: largeDatabase, effectDependencies: true,
    effect: fn => fn(), layoutEffect: fn => fn(), props: { database: largeDatabase, capture: value => { binding = value; } }, mocks: {
      '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
        readLocalCalendar: async (_db, _owner, range) => {
          if (!range) return pendingFull;
          rangedReads.push({ ...range });
          if (rangedReads.length === 1) return pendingFirstBounded;
          return { ...empty, events: [{ title: range.from }] };
        }, readLocalCalendarDrafts: async () => empty, subscribeLocalCalendar: () => () => {} },
      '../../platform/storage/calendar-event-rows': { CalendarHistoryLimitError: HistoryLimit },
      './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
    } });
  try {
    await large.flush(); assert.ok(binding); assert.equal(rangedReads.length, 0);
    binding.loadRange('2030-01-01', '2030-01-31');
    rejectFull(new HistoryLimit());
    await large.flush(); await large.flush();
    assert.deepEqual(rangedReads, [{ from: '2030-01-01', through: '2030-01-31' }],
      'the first fallback uses the latest viewport even when it changes during the unbounded read');
    binding.loadRange('2030-02-01', '2030-02-28'); await large.flush();
    resolveFirstBounded({ ...empty, events: [{ title: '2030-01-01' }] });
    await large.flush(); await large.flush();
    assert.deepEqual(rangedReads, [
      { from: '2030-01-01', through: '2030-01-31' },
      { from: '2030-02-01', through: '2030-02-28' },
    ], 'a viewport change during the first ranged read starts the newer range before publishing');
    assert.deepEqual(binding.snapshot.events.map(event => event.title), ['2030-02-01'], 'the stale January snapshot is never published');
    binding.loadRange('2030-03-01', '2030-03-31'); await large.flush();
    assert.deepEqual(rangedReads.at(-1), { from: '2030-03-01', through: '2030-03-31' });
    const beforeSameRange = rangedReads.length;
    binding.loadRange('2030-03-01', '2030-03-31'); await large.flush();
    assert.equal(rangedReads.length, beforeSameRange, 'a duplicate visible range does not trigger another read');
  } finally { large.unmount(); }
});

test('calendar month scrolling under the history cap issues no additional database reads', async () => {
  const empty = { events: [], categories: [], exceptions: [], draft: null, drafts: [] };
  class HistoryLimit extends Error {}
  let ordinaryReads = 0; let ordinaryBinding;
  const smallDatabase = {};
  const small = screenHarness('tests/helpers/local-calendar-observer-host.tsx', { exportName: 'LocalCalendarObserverHost', database: smallDatabase, effectDependencies: true,
    effect: fn => fn(), layoutEffect: fn => fn(), props: { database: smallDatabase, capture: value => { ordinaryBinding = value; } }, mocks: {
      '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
        readLocalCalendar: async () => { ordinaryReads++; return { ...empty, events: [{ title: 'Saved' }] }; },
        readLocalCalendarDrafts: async () => empty, subscribeLocalCalendar: () => () => {} },
      '../../platform/storage/calendar-event-rows': { CalendarHistoryLimitError: HistoryLimit },
      './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
    } });
  try {
    await small.flush(); assert.equal(ordinaryReads, 1);
    ordinaryBinding.loadRange('2030-01-01', '2030-01-31'); await small.flush();
    ordinaryBinding.loadRange('2030-02-01', '2030-02-28'); await small.flush();
    assert.equal(ordinaryReads, 1, 'passive month navigation below the history cap performs no additional database read');
  } finally { small.unmount(); }
});

test('switching calendar databases hides the previous database snapshot before the next read resolves', async () => {
  const first = {}, second = {}; let release;
  const empty = { events: [], categories: [], exceptions: [], draft: null, drafts: [] };
  const options = { database: first, effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
    '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
      readLocalCalendar: async db => db === first ? { ...empty, events: [{ title: 'Previous private calendar' }] }
        : new Promise(resolve => { release = () => resolve({ ...empty, events: [{ title: 'Current calendar' }] }); }),
      readLocalCalendarDrafts: async () => empty, subscribeLocalCalendar: () => () => {} },
    './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
  } };
  const screen = screenHarness('tests/fixtures/calendar-switch-observer.tsx', options);
  try {
    await screen.flush(); assert.match(screen.text(), /Previous private/);
    options.database = second; screen.render();
    assert.doesNotMatch(screen.text(), /Previous private/);
    release(); await screen.flush(); assert.match(screen.text(), /Current calendar/);
  } finally { release?.(); screen.unmount(); }
});

test('changing group-draft visibility projects retained drafts immediately without rereading unchanged SQLite input', async () => {
  const empty = { events: [], categories: [], exceptions: [], draft: null, drafts: [] }; let reads = 0;
  const props = { includeGroupDrafts: false };
  const { calendarReminderScope } = await import('../src/features/calendar/reminder-preferences.ts');
  const groupId = 'group', userId = 'viewer', ownerScope = calendarReminderScope(userId, groupId);
  const auth = { currentUser: { uid: userId }, onAuthStateChanged: () => () => {} };
  const screen = screenHarness('tests/fixtures/calendar-switch-observer.tsx', { props, database: {}, effectDependencies: true,
    effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { ready: true, userId, active: { protocol: 2, groupId, userId }, group: { groupId, userId, status: 'active' } } } },
      '@/platform/sharing/firebase-services': { isSharingConfigured: () => true, getSharingServices: () => ({ auth }) },
      '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
        readLocalCalendar: async () => { reads++; return { ...empty, drafts: [{ audience: 'group', groupId, ownerScope, value: { title: 'Shared draft' } }] }; },
        readLocalCalendarDrafts: async () => empty, subscribeLocalCalendar: () => () => {} },
      './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
    } });
  try {
    await screen.flush(); assert.doesNotMatch(screen.text(), /Shared draft/); const before = reads;
    props.includeGroupDrafts = true; screen.render();
    assert.match(screen.text(), /Shared draft/); assert.equal(reads, before);
    auth.currentUser = { uid: 'other' }; screen.render();
    assert.doesNotMatch(screen.text(), /Shared draft/); assert.equal(reads, before);
  } finally { screen.unmount(); }
});
