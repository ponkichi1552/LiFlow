import { AppState, Platform } from 'react-native';

import { getGoogleSyncOAuthConfig } from '@/features/google-sync/google-oauth-config';
import { GOOGLE_TASKS_SCOPE } from './google-tasks-api';
import { CalendarPermissionRequiredError, GOOGLE_CALENDAR_FREEBUSY_SCOPE } from '@/features/google-sync/calendar-availability';
import { authorizeCalendarAvailability } from '@/features/google-sync/calendar-authorization';
import { GoogleAccountMismatchError } from '@/features/google-sync/account-binding';
import { GOOGLE_CALENDAR_EVENT_SCOPES } from '../google-calendar/calendar-api';

export class GoogleOAuthConfigurationError extends Error {
  constructor() {
    super('Google OAuth client IDs are not configured');
    this.name = 'GoogleOAuthConfigurationError';
  }
}

export class GoogleSignInRequiredError extends Error {
  constructor() {
    super('Google sign-in is required');
    this.name = 'GoogleSignInRequiredError';
  }
}

export class GoogleAuthorizationCancelledError extends Error {
  constructor() {
    super('Google Tasks authorization was cancelled');
    this.name = 'GoogleAuthorizationCancelledError';
  }
}

type GoogleSignInModule = typeof import('react-native-nitro-google-signin');
type GoogleUser = ReturnType<GoogleSignInModule['GoogleOneTapSignIn']['getCurrentUser']>;
const credentialWork = new Set<Promise<unknown>>();
const GOOGLE_SYNC_SCOPES = [GOOGLE_TASKS_SCOPE, ...GOOGLE_CALENDAR_EVENT_SCOPES, GOOGLE_CALENDAR_FREEBUSY_SCOPE];
const credentialStages = new Set(['restore-session', 'interactive-sign-in', 'explicit-sign-in', 'select-google-account',
  'get-sharing-identity', 'request-scopes', 'request-sync-scopes', 'get-tokens', 'request-calendar-scope', 'request-calendar-events', 'get-calendar-events-token', 'get-calendar-token']);

function redactDiagnostic(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/https?:\/\/\S+/gu, '[url]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, '[email]')
    .replace(/\b(?:eyJ|ya29\.|GOCSPX-)[\w.-]+/gu, '[credential]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|serverAuthCode|client_secret|authorization|code|state)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}&]+)/giu, '$1[redacted]')
    .replace(/[A-Za-z0-9_=-]{48,}/gu, '[redacted]')
    .slice(0, 500);
}

async function authStep<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  const mutatesCredentials = credentialStages.has(stage);
  if (mutatesCredentials && signingOutGoogle) throw new GoogleSignInRequiredError();
  const pending = Promise.resolve().then(operation);
  if (mutatesCredentials) credentialWork.add(pending);
  try {
    return await pending;
  } catch (cause) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      const error = typeof cause === 'object' && cause !== null
        ? cause as { name?: unknown; code?: unknown; message?: unknown }
        : { message: cause };
      console.warn('[google-auth]', {
        stage,
        name: redactDiagnostic(error.name),
        code: redactDiagnostic(error.code),
        message: redactDiagnostic(error.message),
      });
    }
    throw cause;
  } finally { if (mutatesCredentials) credentialWork.delete(pending); }
}

let configuredModule: GoogleSignInModule | null = null;
let configuringModule: Promise<void> | null = null;
let restoringSession: Promise<GoogleUser> | null = null;
let signingOutGoogle: Promise<void> | null = null;

async function loadGoogleSignIn(): Promise<GoogleSignInModule> {
  const { configured, webClientId, iosClientId } = getGoogleSyncOAuthConfig();
  if (!configured || !webClientId || !iosClientId) throw new GoogleOAuthConfigurationError();
  const module = await authStep('load-module', () => {
    // Use the package's CommonJS entry: Metro's dynamic import loses its named exports.
    // Keep loading lazy so web and non-native consumers do not initialize Nitro.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-nitro-google-signin') as GoogleSignInModule;
  });
  if (configuredModule !== module) {
    // Settings/session checks and background work can load the SDK together.
    // Join one configuration, and allow a failed attempt to be retried later.
    if (!configuringModule) {
      configuringModule = authStep('configure', () => module.GoogleOneTapSignIn.configure({
        webClientId,
        iosClientId,
        offlineAccess: false,
        // Identity sign-in is also used by group sharing. Tasks/Calendar consent is
        // requested explicitly by its own feature, never by checking a saved session.
        scopes: [],
      })).then(() => { configuredModule = module; }).finally(() => { configuringModule = null; });
    }
    await configuringModule;
  }
  return module;
}

async function getCurrentGoogleUser(module: GoogleSignInModule): Promise<GoogleUser> {
  if (signingOutGoogle) return null;
  const currentUser = module.GoogleOneTapSignIn.getCurrentUser();
  if (currentUser || Platform.OS !== 'ios') return currentUser;

  // iOS currentUser starts empty after a process restart. Its signIn path silently
  // restores Keychain credentials; Android signIn may show UI, so never use it here.
  if (!restoringSession) {
    restoringSession = authStep('restore-session', () => module.GoogleOneTapSignIn.signIn())
      .then((response) => module.isSuccessResponse(response) ? response.data : null)
      .finally(() => { restoringSession = null; });
  }
  return restoringSession;
}

async function signInForUserAction(): Promise<GoogleSignInModule> {
  if (signingOutGoogle || AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  const module = await loadGoogleSignIn();
  const googleSignIn = module.GoogleOneTapSignIn;
  await authStep('check-services', () => googleSignIn.checkPlayServices());
  if (signingOutGoogle || AppState.currentState !== 'active') throw new GoogleSignInRequiredError();

  let response;
  try { response = await authStep('restore-session', () => googleSignIn.signIn()); }
  catch (cause) {
    // A revoked iOS Keychain credential can fail restoration instead of returning
    // noSavedCredentialFound. Only this explicit foreground action may recover it.
    if (Platform.OS !== 'ios' || AppState.currentState !== 'active') throw cause;
    await selectGoogleUserForAction(module); return module;
  }
  if (module.isNoSavedCredentialFoundResponse(response)) {
    if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
    response = await authStep('interactive-sign-in', () => googleSignIn.createAccount());
  }
  if (module.isCancelledResponse(response)) throw new GoogleAuthorizationCancelledError();
  if (!module.isSuccessResponse(response)) {
    if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
    response = await authStep('explicit-sign-in', () => googleSignIn.presentExplicitSignIn());
  }
  if (module.isCancelledResponse(response) || !module.isSuccessResponse(response)) {
    throw new GoogleAuthorizationCancelledError();
  }
  return module;
}

async function selectGoogleUserForAction(module: GoogleSignInModule): Promise<NonNullable<GoogleUser>> {
  if (signingOutGoogle || AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  await authStep('check-services', () => module.GoogleOneTapSignIn.checkPlayServices());
  if (signingOutGoogle || AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  // Do not restore first: an expired saved credential must not prevent opening
  // the picker. Cancellation never signs out or deletes the previous connection.
  const selected = await authStep('select-google-account', () => module.GoogleOneTapSignIn.presentExplicitSignIn());
  if (module.isCancelledResponse(selected) || !module.isSuccessResponse(selected)) throw new GoogleAuthorizationCancelledError();
  const current = module.GoogleOneTapSignIn.getCurrentUser();
  if (!selected.data.user.id || current?.user.id !== selected.data.user.id) throw new GoogleAccountMismatchError();
  return current;
}

async function getGoogleUserForAction(module: GoogleSignInModule): Promise<GoogleUser> {
  try { return await getCurrentGoogleUser(module); }
  catch (cause) {
    if (Platform.OS !== 'ios' || AppState.currentState !== 'active') throw cause;
    return selectGoogleUserForAction(module);
  }
}

/** Account selection for local Calendar/Tasks does not require a Firebase session. */
export async function selectGoogleSyncAccount(): Promise<{ subject: string; label: string }> {
  if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  const user = await selectGoogleUserForAction(await loadGoogleSignIn());
  return { subject: user.user.id, label: user.user.email || user.user.name || 'Googleアカウント' };
}

/** Expiry is a refresh hint only. Firebase still verifies the signature, issuer and audience. */
export function isGoogleIdentityTokenFresh(token: unknown, now = Date.now()): boolean {
  if (typeof token !== 'string' || typeof atob !== 'function') return false;
  try {
    const payload = token.split('.')[1];
    if (!payload || payload.length > 32_768) return false;
    const base64 = payload.replace(/-/gu, '+').replace(/_/gu, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp * 1000 > now + 60_000;
  } catch { return false; }
}

/** Basic Google identity only. Firebase logout must not sign out or revoke this native Tasks session. */
export async function authorizeGoogleSharingIdentity(options: { selectAccount?: boolean } = {}): Promise<{ idToken: string; googleUserId: string }> {
  if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  const selectAccount = options.selectAccount === true;
  let module = await loadGoogleSignIn();
  let user: GoogleUser;
  if (selectAccount) {
    user = await selectGoogleUserForAction(module);
    if (Platform.OS === 'android' && !isGoogleIdentityTokenFresh(user.idToken)) throw new GoogleSignInRequiredError();
  } else user = await getGoogleUserForAction(module);
  // Android getTokens refreshes the OAuth token but returns its saved ID token.
  // Credential Manager must issue a fresh ID token after that token expires.
  if (!selectAccount && (!user || (Platform.OS === 'android' && !isGoogleIdentityTokenFresh(user.idToken)))) {
    module = await signInForUserAction(); user = await getCurrentGoogleUser(module);
  }
  if (!user) throw new GoogleSignInRequiredError();
  // Credential Manager already returned an audience-bound ID token. Android's
  // getTokens also authorizes OAuth scopes and can require separate consent even
  // for a successful identity-only sign-in. Firebase does not need that token.
  // iOS getTokens refreshes its ID token through the existing native session.
  const idToken = Platform.OS === 'android' ? user.idToken
    : (await authStep('get-sharing-identity', () => module.GoogleOneTapSignIn.getTokens())).idToken;
  if (!idToken || (Platform.OS === 'android' && !isGoogleIdentityTokenFresh(idToken))) throw new GoogleSignInRequiredError();
  if ((await getCurrentGoogleUser(module))?.user.id !== user.user.id) throw new GoogleAccountMismatchError();
  return { idToken, googleUserId: user.user.id };
}

export async function authorizeGoogleTasks(): Promise<void> {
  if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  let module = await loadGoogleSignIn();
  if (!await getGoogleUserForAction(module)) module = await signInForUserAction();
  const googleSignIn = module.GoogleOneTapSignIn;

  const currentUser = await authStep('current-session', () => googleSignIn.getCurrentUser());
  if (!currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE)) {
    const authorization = await authStep('request-scopes', () => googleSignIn.requestScopes([GOOGLE_TASKS_SCOPE]));
    if (!authorization.accessToken) throw new GoogleAuthorizationCancelledError();
  }
  await authStep('get-tokens', () => googleSignIn.getTokens());
}

export type GoogleSyncConnection = { subject: string; label: string; authorized: boolean };

/** Passive status uses one identity read; it never requests tokens or additional consent. */
export async function readGoogleSyncConnection(): Promise<GoogleSyncConnection | null> {
  const user = await getCurrentGoogleUser(await loadGoogleSignIn());
  if (!user?.user.id) return null;
  return { subject: user.user.id, label: (user.user.email || user.user.name || 'Googleアカウント').slice(0, 320),
    authorized: GOOGLE_SYNC_SCOPES.every(scope => user.scopes.includes(scope)) };
}

/** One explicit consent for Calendar, Tasks and availability; feature ON flags remain separate. */
export async function authorizeGoogleSyncConnection(): Promise<GoogleSyncConnection> {
  if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  let module = await loadGoogleSignIn(); let user = await getGoogleUserForAction(module);
  if (!user) { module = await signInForUserAction(); user = await getCurrentGoogleUser(module); }
  if (!user?.user.id) throw new GoogleSignInRequiredError();
  const subject = user.user.id;
  const missing = GOOGLE_SYNC_SCOPES.filter(scope => !user!.scopes.includes(scope));
  if (missing.length) {
    const response = await authStep('request-sync-scopes', () => module.GoogleOneTapSignIn.requestScopes(missing));
    if (!response.accessToken) throw new GoogleAuthorizationCancelledError();
  }
  const validate = async () => {
    const current = await getCurrentGoogleUser(module);
    if (current?.user.id !== subject) throw new GoogleAccountMismatchError();
    if (GOOGLE_SYNC_SCOPES.some(scope => !current.scopes.includes(scope))) throw new CalendarPermissionRequiredError();
    return current;
  };
  await validate();
  const tokens = await authStep('get-tokens', () => module.GoogleOneTapSignIn.getTokens());
  const current = await validate();
  if (!tokens.accessToken) throw new GoogleSignInRequiredError();
  return { subject, label: (current.user.email || current.user.name || 'Googleアカウント').slice(0, 320), authorized: true };
}

export async function getGoogleTasksAccessToken(expectedSubject?: string): Promise<string> {
  await (await import('../subscription/runtime')).assertSubscriptionAccess();
  const module = await loadGoogleSignIn();
  const currentUser = await getCurrentGoogleUser(module);
  if (!currentUser) throw new GoogleSignInRequiredError();
  if (expectedSubject && currentUser.user.id !== expectedSubject) throw new GoogleAccountMismatchError();
  if (!currentUser.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new GoogleSignInRequiredError();
  const tokens = await authStep('get-tokens', () => module.GoogleOneTapSignIn.getTokens());
  const after = await getCurrentGoogleUser(module);
  if (after?.user.id !== currentUser.user.id) throw new GoogleAccountMismatchError();
  if (!after?.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new GoogleSignInRequiredError();
  return tokens.accessToken;
}

export async function getCurrentGoogleSubject(): Promise<string | null> {
  return (await getCurrentGoogleUser(await loadGoogleSignIn()))?.user.id ?? null;
}

/** Public account label for an explicit connection review. No token or interactive fallback leaves this boundary. */
export async function getCurrentGoogleCalendarAccount(): Promise<{ subject: string; label: string } | null> {
  const current = await getCurrentGoogleUser(await loadGoogleSignIn()); if (!current?.user.id) return null;
  const label = current.user.email?.trim() || current.user.name?.trim() || `Googleアカウント（${current.user.id.slice(-6)}）`;
  return { subject: current.user.id, label: label.slice(0, 320) };
}

/** Explicitly restore a missing Native session. Never replace an existing session or sign in to Firebase. */
export async function restorePrivateGoogleCalendarAccount(): Promise<{ subject: string; label: string }> {
  if (AppState.currentState !== 'active') throw new GoogleSignInRequiredError();
  const current = await getGoogleUserForAction(await loadGoogleSignIn());
  if (!current) await signInForUserAction(); const restored = await getCurrentGoogleCalendarAccount();
  if (!restored) throw new GoogleSignInRequiredError(); return restored;
}

export async function hasGoogleTasksSession(expectedSubject?: string): Promise<boolean> {
  try {
    const module = await loadGoogleSignIn();
    const currentUser = await getCurrentGoogleUser(module);
    return Boolean(currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE) && (!expectedSubject || currentUser.user.id === expectedSubject));
  } catch {
    return false;
  }
}

/** A saved ON flag is not a native connection. Status reads request neither tokens nor consent. */
export async function hasGoogleCalendarEventsSession(expectedSubject: string): Promise<boolean> {
  try {
    const user = await getCurrentGoogleUser(await loadGoogleSignIn());
    return Boolean(expectedSubject && user?.user.id === expectedSubject
      && GOOGLE_CALENDAR_EVENT_SCOPES.every(scope => user.scopes.includes(scope)));
  } catch { return false; }
}

/** Forget local Google credentials without revoking the user's grants or deleting remote data. */
export async function signOutGoogleSyncAccount(): Promise<void> {
  if (signingOutGoogle) return signingOutGoogle;
  if (!getGoogleSyncOAuthConfig().configured) return;
  const pending = (async () => {
    const module = await loadGoogleSignIn();
    await Promise.allSettled([...credentialWork]);
    // A cold Keychain restore must settle before signOut, or its late callback
    // could recreate the native session after the user has logged out.
    await restoringSession?.catch(() => null);
    await authStep('sign-out', () => module.GoogleOneTapSignIn.signOut());
  })();
  signingOutGoogle = pending;
  try { await pending; } finally { if (signingOutGoogle === pending) signingOutGoogle = null; }
}

/** Incremental consent is only invoked by the settings ON/retry button. */
export async function authorizeGoogleCalendarAvailability(): Promise<void> {
  await authorizeSelectedCalendarAccount(true);
}

/** Explicit private-source consent can follow identity-only sharing login; it never adds Tasks scope. */
export async function authorizePrivateGoogleCalendarSource(expectedSubject: string): Promise<void> {
  if (typeof expectedSubject !== 'string' || !expectedSubject) throw new GoogleAccountMismatchError();
  await authorizeSelectedCalendarAccount(false, expectedSubject);
}
async function authorizeSelectedCalendarAccount(requireTasks: boolean, expectedSubject?: string): Promise<void> {
  if (AppState.currentState !== 'active') throw new CalendarPermissionRequiredError();
  const module = await loadGoogleSignIn();
  const current = await getCurrentGoogleUser(module);
  if (!current || requireTasks && !current.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new CalendarPermissionRequiredError();
  if (expectedSubject && current.user.id !== expectedSubject) throw new GoogleAccountMismatchError();
  await authorizeCalendarAvailability({
    grantedScopes: async () => {
      const selected = await getCurrentGoogleUser(module);
      if (selected?.user.id !== current.user.id) throw new GoogleAccountMismatchError(); return selected.scopes;
    },
    requestScopes: (scopes) => authStep('request-calendar-scope', () => module.GoogleOneTapSignIn.requestScopes(scopes)),
  });
  if ((await getCurrentGoogleUser(module))?.user.id !== current.user.id) throw new GoogleAccountMismatchError();
}

/** Explicit Calendar event consent reuses the selected native Google identity. */
export async function authorizeGoogleCalendarEvents(expectedSubject?: string): Promise<{ subject: string; label: string }> {
  if (AppState.currentState !== 'active') throw new CalendarPermissionRequiredError();
  let module = await loadGoogleSignIn(); let user = await getGoogleUserForAction(module);
  if (!user) { module = await signInForUserAction(); user = await getCurrentGoogleUser(module); }
  if (!user) throw new GoogleSignInRequiredError();
  if (expectedSubject && user.user.id !== expectedSubject) throw new GoogleAccountMismatchError();
  const subject = user.user.id;
  if (GOOGLE_CALENDAR_EVENT_SCOPES.some(scope => !user!.scopes.includes(scope))) {
    await authStep('request-calendar-events', () => module.GoogleOneTapSignIn.requestScopes([...GOOGLE_CALENDAR_EVENT_SCOPES]));
  }
  const after = await getCurrentGoogleUser(module);
  if (after?.user.id !== subject) throw new GoogleAccountMismatchError();
  if (GOOGLE_CALENDAR_EVENT_SCOPES.some(scope => !after.scopes.includes(scope))) throw new CalendarPermissionRequiredError();
  return { subject, label: after.user.email || after.user.name || 'Googleアカウント' };
}

/** Background-safe. It never presents sign-in or requests an additional scope. */
export async function getGoogleCalendarEventsAccessToken(expectedSubject: string): Promise<string> {
  await (await import('../subscription/runtime')).assertSubscriptionAccess();
  const module = await loadGoogleSignIn(); const user = await getCurrentGoogleUser(module);
  if (!user || !expectedSubject || user.user.id !== expectedSubject) throw new GoogleAccountMismatchError();
  if (GOOGLE_CALENDAR_EVENT_SCOPES.some(scope => !user.scopes.includes(scope))) throw new CalendarPermissionRequiredError();
  const token = await authStep('get-calendar-events-token', () => module.GoogleOneTapSignIn.getTokens());
  const after = await getCurrentGoogleUser(module);
  if (after?.user.id !== expectedSubject) throw new GoogleAccountMismatchError();
  if (GOOGLE_CALENDAR_EVENT_SCOPES.some(scope => !after.scopes.includes(scope))) throw new CalendarPermissionRequiredError();
  return token.accessToken;
}


/** Non-interactive: no requestScopes/createAccount/presentExplicitSignIn fallback. */
export async function getGoogleCalendarAccessToken(expectedSubject?: string): Promise<string> {
  await (await import('../subscription/runtime')).assertSubscriptionAccess();
  const module = await loadGoogleSignIn();
  const user = await getCurrentGoogleUser(module);
  if (user && expectedSubject && user.user.id !== expectedSubject) throw new GoogleAccountMismatchError();
  if (!user?.scopes.includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) throw new CalendarPermissionRequiredError();
  const tokens = await authStep('get-calendar-token', () => module.GoogleOneTapSignIn.getTokens());
  // Android can silently fall back to the still-granted Tasks scope after Calendar revocation.
  const after = await getCurrentGoogleUser(module);
  if (after?.user.id !== user.user.id) throw new GoogleAccountMismatchError();
  if (!after?.scopes.includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) {
    throw new CalendarPermissionRequiredError();
  }
  return tokens.accessToken;
}

export async function disconnectGoogleTasksSession(): Promise<void> {
  const module = await loadGoogleSignIn();
  const googleSignIn = module.GoogleOneTapSignIn;
  try {
    const currentUser = await getCurrentGoogleUser(module);
    if (currentUser) await googleSignIn.revokeAccess(currentUser.user.id);
  } finally {
    await googleSignIn.signOut();
  }
}
