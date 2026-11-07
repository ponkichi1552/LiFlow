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
  const screen = screenHarness('tests/fixtures/calendar-switch-observer.tsx', { props, database: {}, effectDependencies: true,
    effect: fn => fn(), layoutEffect: fn => fn(), mocks: {
      '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: empty,
        readLocalCalendar: async () => { reads++; return { ...empty, drafts: [{ audience: 'group', value: { title: 'Shared draft' } }] }; },
        readLocalCalendarDrafts: async () => empty, subscribeLocalCalendar: () => () => {} },
      './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} },
    } });
  try {
    await screen.flush(); assert.doesNotMatch(screen.text(), /Shared draft/); const before = reads;
    props.includeGroupDrafts = true; screen.render();
    assert.match(screen.text(), /Shared draft/); assert.equal(reads, before);
  } finally { screen.unmount(); }
});
