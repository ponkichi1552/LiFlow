import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';

test('native personal Google synchronization reads the current title preference without requesting another account', () => {
  let shorten = true; let options; let authorizations = 0;
  const readCalendarTitleShortening = () => shorten;
  const module = loadNativeModule('src/platform/google-calendar/personal-runtime.ts', {
    '../../domain/scheduling/local-date': { localDateFromDate: () => '2026-11-16' },
    '../../features/calendar/use-title-display': { readCalendarTitleShortening },
    '../../features/calendar/personal-google-sync': { createPersonalGoogleCalendarSync: input => { options = input; return { sync: () => {} }; } },
    './calendar-api': { createGoogleCalendarApi: () => { throw new Error('No transport during preference reads'); } },
    '../google-tasks/google-sign-in-gateway': { authorizeGoogleCalendarEvents: () => { authorizations++; }, getCurrentGoogleSubject: async () => 'same-account',
      hasGoogleCalendarEventsSession: async () => true, getGoogleCalendarEventsAccessToken: () => { throw new Error('No token during preference reads'); } },
  });
  const database = {}; const runtime = module.nativePersonalGoogleCalendar(database);
  assert.equal(options.database, database); assert.equal(options.readTitleShortening(), true);
  shorten = false; assert.equal(options.readTitleShortening(), false);
  assert.equal(module.nativePersonalGoogleCalendar(database), runtime); assert.equal(authorizations, 0);
});

test('native shared Google export reads the same live title preference and keeps the existing account and access callbacks', () => {
  let shorten = false; let options; const repository = {}; const store = {}; let authorizations = 0;
  const assertAccess = async () => {}; const currentSubject = async () => 'same-account';
  const module = loadNativeModule('src/platform/sharing/v2-google-calendar.ts', {
    '../storage/sharing-v2-calendar-export': { createSharedCalendarExportStore: value => { assert.equal(value, repository); return store; } },
    '../../features/calendar/shared-google-export': { createSharedGoogleCalendarExport: input => { options = input; return {}; } },
    '../../features/calendar/use-title-display': { readCalendarTitleShortening: () => shorten },
    '../google-calendar/calendar-api': { createGoogleCalendarApi: () => { throw new Error('No transport during preference reads'); } },
    '../google-tasks/google-sign-in-gateway': { authorizeGoogleCalendarEvents: () => { authorizations++; }, getCurrentGoogleSubject: currentSubject,
      getGoogleCalendarEventsAccessToken: () => { throw new Error('No token during preference reads'); } },
  });
  module.createNativeV2GoogleCalendar({ repository, userId: 'owner', groupId: 'same-home', assertAccess });
  assert.equal(options.store, store); assert.equal(options.assertAccess, assertAccess); assert.equal(options.currentSubject, currentSubject);
  assert.equal(options.readTitleShortening(), false); shorten = true; assert.equal(options.readTitleShortening(), true); assert.equal(authorizations, 0);
});
