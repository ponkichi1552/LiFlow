import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/typescript-loader.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
const availability = await import('../src/features/google-sync/calendar-availability.ts');
const authorization = await import('../src/features/google-sync/calendar-authorization.ts');
const accountBinding = await import('../src/features/google-sync/account-binding.ts');
const tasksScope = 'https://www.googleapis.com/auth/tasks';
const calendarScope = availability.GOOGLE_CALENDAR_FREEBUSY_SCOPE;

function harness(platform, { scopes = [tasksScope, calendarScope], cold = false, state = 'active', deny = false, expectedScopes = [calendarScope] } = {}) {
  const freshToken = `synthetic.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic`;
  const events = []; let user = cold ? null : { scopes: [...scopes], user: { id: 'fixture-user' }, idToken: freshToken };
  const sdk = {
    configure: async (options) => { events.push('configure'); assert.deepEqual(options.scopes, []); },
    getCurrentUser: () => user,
    signIn: async () => { events.push('restore'); user = { scopes: [...scopes], user: { id: 'fixture-user' }, idToken: freshToken }; return { type: 'success', data: user }; },
    getTokens: async () => { events.push('tokens'); return { accessToken: 'fixture-access-token' }; },
    requestScopes: async (requested) => {
      events.push('consent'); assert.deepEqual(requested, expectedScopes);
      if (deny) return {};
      user = { ...user, scopes: [...new Set([...user.scopes, ...requested])] };
      return { accessToken: 'fixture-access-token' };
    },
    createAccount: async () => assert.fail('noninteractive flow opened account creation'),
    presentExplicitSignIn: async () => assert.fail('noninteractive flow opened sign-in UI'),
    checkPlayServices: async () => { events.push('check-services'); },
  };
  const appState = { currentState: state };
  const gateway = loadNativeModule('src/platform/google-tasks/google-sign-in-gateway.ts', {
    'react-native': { Platform: { OS: platform }, AppState: appState },
    '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: true, webClientId: 'fixture-web', iosClientId: 'fixture-ios' }) },
    './google-tasks-api': { GOOGLE_TASKS_SCOPE: tasksScope },
    '@/features/google-sync/calendar-availability': availability,
    '@/features/google-sync/calendar-authorization': authorization,
    '@/features/google-sync/account-binding': accountBinding,
    'react-native-nitro-google-signin': { GoogleOneTapSignIn: sdk, isSuccessResponse: (value) => value?.type === 'success',
      isNoSavedCredentialFoundResponse: (value) => value?.type === 'noSavedCredentialFound', isCancelledResponse: (value) => value?.type === 'cancelled' },
  });
  return { gateway, events, sdk, appState, identityToken: freshToken, setScopes: (next) => { user = { ...user, scopes: next }; },
    changeAccount: (id) => { user = { ...user, user: { id } }; },
    expireIdentity: () => { user = { ...user, idToken: 'synthetic.eyJleHAiOjF9.synthetic' }; } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} private Calendar consent after identity-only login adds only freebusy for the explicitly selected account`, async () => {
    const h = harness(platform, { scopes: [] }); const account = await h.gateway.getCurrentGoogleCalendarAccount();
    assert.equal(account.subject, 'fixture-user'); assert.deepEqual(Object.keys(account).sort(), ['label','subject']);
    await h.gateway.authorizePrivateGoogleCalendarSource(account.subject);
    assert.equal(h.events.filter(event => event === 'consent').length, 1); assert.equal(await h.gateway.hasGoogleTasksSession(), false);
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(account.subject), 'fixture-access-token');
  });
  test(`${platform} private Calendar consent rejects a substituted account or an account change during the permission response`, async () => {
    const h = harness(platform, { scopes: [] }); await assert.rejects(() => h.gateway.authorizePrivateGoogleCalendarSource('foreign-subject'), accountBinding.GoogleAccountMismatchError);
    assert.equal(h.events.includes('consent'), false);
    h.sdk.requestScopes = async () => { h.changeAccount('substituted-during-consent'); h.setScopes([calendarScope]); return { accessToken: 'fixture-access-token' }; };
    await assert.rejects(() => h.gateway.authorizePrivateGoogleCalendarSource('fixture-user'), accountBinding.GoogleAccountMismatchError);
  });
  test(`${platform} private Calendar permissions never open in background or replace a missing Google session`, async () => {
    const h = harness(platform, { scopes: [], state: 'background' });
    await assert.rejects(() => h.gateway.authorizePrivateGoogleCalendarSource('fixture-user'), availability.CalendarPermissionRequiredError); assert.deepEqual(h.events, []);
    if (platform === 'android') { const cold = harness(platform, { cold: true }); assert.equal(await cold.gateway.getCurrentGoogleCalendarAccount(), null); assert.equal(cold.events.includes('restore'), false); }
  });
  test(`${platform} explicit private Google restore preserves an existing Native account and never requests Tasks or Calendar scopes`, async () => {
    const h = harness(platform, { scopes: [] }); assert.equal((await h.gateway.restorePrivateGoogleCalendarAccount()).subject, 'fixture-user');
    assert.equal(h.events.includes('restore'), false); assert.equal(h.events.includes('consent'), false);
    const cold = harness(platform, { cold: true, scopes: [] }); assert.equal((await cold.gateway.restorePrivateGoogleCalendarAccount()).subject, 'fixture-user');
    assert.equal(cold.events.filter(event => event === 'restore').length, 1); assert.equal(cold.events.includes('consent'), false);
    const background = harness(platform, { cold: true, state: 'background' }); await assert.rejects(() => background.gateway.restorePrivateGoogleCalendarAccount(), background.gateway.GoogleSignInRequiredError); assert.deepEqual(background.events, []);
  });
  test(`${platform} sharing identity never implicitly requests Tasks or Calendar permissions`, async () => {
    const h = harness(platform, { scopes: [] });
    h.sdk.getTokens = async () => { h.events.push('identity-token'); return { idToken: 'fixture-id-token' }; };
    assert.deepEqual(await h.gateway.authorizeGoogleSharingIdentity(), { idToken: platform === 'android' ? h.identityToken : 'fixture-id-token', googleUserId: 'fixture-user' });
    assert.deepEqual(h.events, platform === 'android' ? ['configure'] : ['configure', 'identity-token']); assert.equal(await h.gateway.hasGoogleTasksSession(), false);
  });
  test(`${platform} Tasks consent remains explicit after a sharing-only identity login`, async () => {
    const h = harness(platform, { scopes: [] });
    h.sdk.requestScopes = async (requested) => { assert.deepEqual(requested, [tasksScope]); h.setScopes([tasksScope]); h.events.push('tasks-consent');
      return { accessToken: 'fixture-access-token' }; };
    await h.gateway.authorizeGoogleTasks();
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-access-token');
    assert.equal(h.events.filter((event) => event === 'tasks-consent').length, 1);
  });
  test(`${platform} sharing identity cannot open a login flow while the app is in the background`, async () => {
    const h = harness(platform, { state: 'background', cold: true });
    await assert.rejects(h.gateway.authorizeGoogleSharingIdentity(), h.gateway.GoogleSignInRequiredError);
    assert.deepEqual(h.events, []);
  });
  test(`${platform} sharing identity refreshes an expired Android ID token without adding Tasks or Calendar consent`, async () => {
    const h = harness(platform, { scopes: [] }); h.expireIdentity();
    h.sdk.getTokens = async () => ({ idToken: 'fixture-fresh-id-token' });
    await h.gateway.authorizeGoogleSharingIdentity();
    assert.equal(h.events.filter((event) => event === 'restore').length, platform === 'android' ? 1 : 0);
    assert.equal(h.events.includes('consent'), false);
  });
  for (const state of ['active', 'background', 'inactive']) {
    test(`${platform} ${state} Calendar token acquisition does not request consent or open interactive login`, async () => {
      const h = harness(platform, { state });
      assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token');
      assert.deepEqual(h.events, ['configure', 'tokens']);
    });
  }
  test(`${platform} Calendar incremental consent only adds freebusy and preserves Tasks`, async () => {
    const h = harness(platform, { scopes: [tasksScope] });
    await h.gateway.authorizeGoogleCalendarAvailability();
    await h.gateway.authorizeGoogleCalendarAvailability();
    assert.equal(h.events.filter((event) => event === 'consent').length, 1);
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-access-token');
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token');
  });
  test(`${platform} denied Calendar consent retains Tasks and can be retried`, async () => {
    const h = harness(platform, { scopes: [tasksScope], deny: true });
    await assert.rejects(h.gateway.authorizeGoogleCalendarAvailability(), availability.CalendarPermissionRequiredError);
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-access-token');
    assert.equal(await h.gateway.hasGoogleTasksSession(), true);
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
    assert.equal(h.events.filter((event) => event === 'consent').length, 1);
  });
  for (const state of ['background', 'inactive']) {
    test(`${platform} ${state} cannot initiate Calendar permission UI`, async () => {
      const h = harness(platform, { scopes: [tasksScope], state });
      await assert.rejects(h.gateway.authorizeGoogleCalendarAvailability(), availability.CalendarPermissionRequiredError);
      assert.deepEqual(h.events, []);
    });
  }
  test(`${platform} missing Calendar scope never borrows the Tasks token`, async () => {
    const h = harness(platform, { scopes: [tasksScope] });
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
    assert.equal(h.events.includes('tokens'), false);
  });
  test(`${platform} Calendar revocation during native token retrieval cannot be mistaken for a Calendar token`, async () => {
    const h = harness(platform);
    h.sdk.getTokens = async () => { h.setScopes([tasksScope]); return { accessToken: 'fixture-tasks-only' }; };
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-tasks-only');
  });
  test(`${platform} a revoked Tasks grant cannot return an identity-only token as a Tasks access token`, async () => {
    const h = harness(platform);
    h.sdk.getTokens = async () => { h.setScopes([]); return { accessToken: 'fixture-profile-only' }; };
    await assert.rejects(h.gateway.getGoogleTasksAccessToken(), h.gateway.GoogleSignInRequiredError);
  });
  test(`${platform} an unexpected Google subject is rejected before token retrieval for both features`, async () => {
    const h = harness(platform);
    await assert.rejects(h.gateway.getGoogleTasksAccessToken('other-account'), accountBinding.GoogleAccountMismatchError);
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken('other-account'), accountBinding.GoogleAccountMismatchError);
    assert.equal(h.events.includes('tokens'), false);
  });
  test(`${platform} changing accounts during native token retrieval cannot apply a token to old task mappings`, async () => {
    const h = harness(platform);
    h.sdk.getTokens = async () => { h.changeAccount('changed-account'); return { accessToken: 'synthetic-other-account' }; };
    await assert.rejects(h.gateway.getGoogleTasksAccessToken('fixture-user'), accountBinding.GoogleAccountMismatchError);
  });
  test(`${platform} 100 concurrent session checks configure the native SDK once`, async () => {
    const h = harness(platform);
    assert.ok((await Promise.all(Array.from({ length: 100 }, () => h.gateway.hasGoogleTasksSession()))).every(Boolean));
    assert.equal(h.events.filter((event) => event === 'configure').length, 1);
  });
  test(`${platform} native configuration failure is retried after the failed attempt settles`, async () => {
    const h = harness(platform); let attempts = 0;
    h.sdk.configure = async () => { if (++attempts === 1) throw new Error('fixture configure failure'); };
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), /fixture configure failure/u);
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token');
    assert.equal(attempts, 2);
  });
  test(`${platform} 100 simultaneous configuration failures share one attempt and allow a later retry`, async () => {
    const h = harness(platform); let attempts = 0;
    h.sdk.configure = async () => { if (++attempts === 1) throw new Error('fixture shared failure'); };
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => h.gateway.getGoogleCalendarAccessToken()));
    assert.ok(results.every((result) => result.status === 'rejected')); assert.equal(attempts, 1);
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token'); assert.equal(attempts, 2);
  });
}

test('Android sharing succeeds with a fresh Credential Manager ID token even when OAuth authorization requires resolution', async () => {
  const h = harness('android', { scopes: [] });
  h.sdk.getTokens = async () => { throw new Error('Additional authorization requires an explicit foreground action.'); };
  assert.deepEqual(await h.gateway.authorizeGoogleSharingIdentity(), { idToken: h.identityToken, googleUserId: 'fixture-user' });
  assert.deepEqual(h.events, ['configure']);
});

test('iOS cold session restores Keychain once for 100 concurrent Calendar checks', async () => {
  const h = harness('ios', { cold: true });
  const results = await Promise.all(Array.from({ length: 100 }, () => h.gateway.getGoogleCalendarAccessToken()));
  assert.ok(results.every((token) => token === 'fixture-access-token'));
  assert.equal(h.events.filter((event) => event === 'restore').length, 1);
  assert.equal(h.events.includes('consent'), false);
});

test('Android missing saved session never attempts the potentially interactive signIn fallback', async () => {
  const h = harness('android', { cold: true });
  await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
  await assert.rejects(h.gateway.getGoogleTasksAccessToken(), h.gateway.GoogleSignInRequiredError);
  assert.equal(h.events.includes('restore'), false);
  assert.equal(h.events.includes('consent'), false);
});

for (const platform of ['ios', 'android']) {
  const eventScopes = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
  test(`${platform} Calendar event consent reuses the selected identity and background tokens never request new scopes`, async () => {
    const f = harness(platform, { scopes: [], expectedScopes: eventScopes });
    assert.equal((await f.gateway.authorizeGoogleCalendarEvents('fixture-user')).subject, 'fixture-user');
    assert.equal(f.events.filter(event => event === 'consent').length, 1);
    f.appState.currentState = 'background'; const before = f.events.filter(event => event === 'consent').length;
    assert.equal(await f.gateway.getGoogleCalendarEventsAccessToken('fixture-user'), 'fixture-access-token');
    f.setScopes([tasksScope]); await assert.rejects(f.gateway.getGoogleCalendarEventsAccessToken('fixture-user'));
    assert.equal(f.events.filter(event => event === 'consent').length, before);
    await assert.rejects(f.gateway.authorizeGoogleCalendarEvents('fixture-user'));
  });
  test(`${platform} Calendar event token rejects account or permission substitution during native refresh`, async () => {
    const f = harness(platform, { scopes: eventScopes });
    f.sdk.getTokens = async () => { f.changeAccount('substituted'); return { accessToken: 'wrong-account-token' }; };
    await assert.rejects(f.gateway.getGoogleCalendarEventsAccessToken('fixture-user'));
    const revoked = harness(platform, { scopes: eventScopes });
    revoked.sdk.getTokens = async () => { revoked.setScopes([]); return { accessToken: 'missing-calendar-token' }; };
    await assert.rejects(revoked.gateway.getGoogleCalendarEventsAccessToken('fixture-user'));
    assert.equal(revoked.events.includes('consent'), false);
  });
}
