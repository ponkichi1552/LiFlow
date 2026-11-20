import { onAuthStateChanged } from 'firebase/auth';
import type { Auth } from 'firebase/auth';
import { getSharingServices } from './firebase-services';
import { openPrivateCalendarDevices } from './private-calendar-devices';
import { createPrivateCalendarCloud } from './private-calendar-cloud';
import { nativePrivateCalendarCrypto } from './native-private-calendar-crypto';
import { nativePrivateCalendarSecrets, nativePrivateCalendarSource, nativePrivateCalendarAuthorityIntents, nativePrivateCalendarCache, nativePrivatePlannerPreferences } from './private-calendar-secrets';
import { createPrivateCalendarAuthoritySync } from '../../features/sharing/private-calendar/authority-sync';
import { createPrivateCalendarSourceController } from '../../features/sharing/private-calendar/source-controller';
import { createPrivateCalendarRuntime } from '../../features/sharing/private-calendar/runtime';
import type { PrivateCalendarRuntime } from '../../features/sharing/private-calendar/runtime';
import { getDeviceTimeZone } from '../../features/google-sync/calendar-availability';
import { withGoogleSyncOperation } from '../../features/google-sync/operation-lock';
import { createCalendarFreeBusyClient } from '../google-tasks/google-calendar-freebusy-client';
import { authorizePrivateGoogleCalendarSource, getCurrentGoogleCalendarAccount, getCurrentGoogleSubject, getGoogleCalendarAccessToken, restorePrivateGoogleCalendarAccount } from '../google-tasks/google-sign-in-gateway';
import { GoogleAccountMismatchError } from '../../features/google-sync/account-binding';
import { assertSharedIdentifier } from '../../features/sharing/identifier';
import { privateCalendarDeadlineError } from '../../features/sharing/private-calendar/sync-deadline';
import { createPrivatePreferenceSync } from '../../features/sharing/private-planner/preference-sync';
import { createPrivatePlannerCloud } from './private-planner-cloud';
import type { PrivateDeliveryPort } from './private-delivery';

const runtimes = new Map<string, PrivateCalendarRuntime>(); let observedAuth: Auth | null = null; let stopObserving: (() => void) | undefined;
/** Importing this module does not initialize Firebase, Google, a DB, or any periodic worker. */
export function openPrivateCalendarRuntime(userId: string): PrivateCalendarRuntime {
  assertSharedIdentifier(userId); const { auth, firestore } = getSharingServices();
  const assertOwner = () => { if (auth.currentUser?.uid !== userId) throw new Error('本人用Calendarのアカウントが変わりました。'); }; assertOwner();
  if (observedAuth !== auth) {
    stopObserving?.(); for (const runtime of runtimes.values()) runtime.invalidatePlaintext(); runtimes.clear(); observedAuth = auth;
    stopObserving = onAuthStateChanged(auth, user => { for (const [owner, runtime] of runtimes) if (owner !== user?.uid) runtime.invalidatePlaintext(); });
  }
  const saved = runtimes.get(userId); if (saved) return saved;
  const secrets = nativePrivateCalendarSecrets; const source = nativePrivateCalendarSource(userId); const intents = nativePrivateCalendarAuthorityIntents(userId);
  let deliveryPromise: Promise<PrivateDeliveryPort> | undefined;
  const loadDelivery = () => deliveryPromise ??= (async () => {
    const [{ createPrivateDelivery }, { nativePrivateDeliveryArchive }, { signSharedDocument }] = await Promise.all([
      import('./private-delivery'), import('./private-calendar-secrets'), import('../../features/sharing/crypto'),
    ]);
    return createPrivateDelivery({ firestore, userId, assertOwner, archive: await nativePrivateDeliveryArchive(userId),
      async sign(value, deviceId) {
        assertOwner(); const identity = await secrets.identity(userId); assertOwner();
        if (identity.deviceId !== deviceId) throw new Error('本人用の端末が変わりました。');
        return signSharedDocument(value, identity);
      },
      state: async () => { const value = await secrets.publicState(userId); return value ? { identity: value.identity, authority: value.authority ?? null } : null; } });
  })();
  const delivery: PrivateDeliveryPort | undefined = process.env.EXPO_PUBLIC_SHARING_EPHEMERAL_DELIVERY === '1' ? {
    remember: async (...args) => (await loadDelivery()).remember(...args), recover: async (...args) => (await loadDelivery()).recover(...args),
    confirm: async (...args) => (await loadDelivery()).confirm(...args), prepare: async (...args) => (await loadDelivery()).prepare(...args),
    has: async (...args) => (await loadDelivery()).has(...args),
    watch(changed, failed) {
      let disposed = false; let unsubscribe: (() => void) | undefined;
      void loadDelivery().then(value => { if (!disposed) unsubscribe = value.watch(changed, failed); }).catch(error => { if (!disposed) failed(error); });
      return () => { disposed = true; unsubscribe?.(); };
    },
  } : undefined;
  const cloud = createPrivateCalendarCloud(firestore, userId, () => auth.currentUser?.uid ?? null, nativePrivateCalendarCrypto, delivery);
  const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets, intents, cloud });
  const client = createCalendarFreeBusyClient();
  const plannerPreferences = nativePrivatePlannerPreferences(userId);
  const plannerSync = createPrivatePreferenceSync({ ownerUserId: userId, assertOwner, store: plannerPreferences, secrets, crypto: nativePrivateCalendarCrypto,
    cloud: createPrivatePlannerCloud(firestore, userId, () => auth.currentUser?.uid ?? null, delivery) });
  const runtime = createPrivateCalendarRuntime({ userId, assertOwner, secrets, source, cloud, devices: openPrivateCalendarDevices(userId),
    plannerPreferences, plannerSync,
    cache: nativePrivateCalendarCache(userId), crypto: nativePrivateCalendarCrypto, sourceController: createPrivateCalendarSourceController({ userId, secrets, source, intents, authoritySync }),
    timeZone: getDeviceTimeZone,
    currentGoogleAccount: () => withGoogleSyncOperation(async () => { assertOwner(); const account = await getCurrentGoogleCalendarAccount(); assertOwner(); return account; }),
    restoreGoogleAccount: () => withGoogleSyncOperation(async () => { assertOwner(); const account = await restorePrivateGoogleCalendarAccount(); assertOwner(); return account; }),
    authorizeGoogleSource: expected => withGoogleSyncOperation(async () => { assertOwner(); await authorizePrivateGoogleCalendarSource(expected); assertOwner(); }),
    queryGoogle: (expected, range, options = {}) => withGoogleSyncOperation(async () => {
      const remaining = () => { const value = Math.min(60_000, options.deadline === undefined ? 60_000 : options.deadline - Date.now());
        options.assertBudget?.(); if (options.signal?.aborted || value < 1) throw privateCalendarDeadlineError(); return value; };
      assertOwner(); remaining(); const token = await getGoogleCalendarAccessToken(expected); assertOwner();
      const busy = await client.query(token, range, { timeoutMs: remaining(), maxIntervals: 100_000, ...(options.signal ? { signal: options.signal } : {}) }); assertOwner();
      remaining();
      if (await getCurrentGoogleSubject() !== expected) throw new GoogleAccountMismatchError(); assertOwner(); return busy;
    }) });
  runtimes.set(userId, runtime); return runtime;
}
