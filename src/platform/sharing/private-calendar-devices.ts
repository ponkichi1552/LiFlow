import { getSharingServices } from './firebase-services';
import { createPrivateCalendarCloud } from './private-calendar-cloud';
import { createPrivateCalendarConnectionCloud } from './private-calendar-connection-cloud';
import { nativePrivateCalendarCrypto } from './native-private-calendar-crypto';
import { nativePrivateCalendarSecrets, nativePrivateCalendarRootSetup, nativePrivateCalendarAuthorityIntents,
  nativePrivateCalendarPairing, nativePrivateCalendarConnections, nativePrivateCalendarKeyOutbox, nativePrivateCalendarCache } from './private-calendar-secrets';
import { createPrivateCalendarDeviceSession } from '../../features/sharing/private-calendar/device-session';
import type { PrivateCalendarDeviceSession } from '../../features/sharing/private-calendar/device-session';
import { assertSharedIdentifier } from '../../features/sharing/identifier';

const sessions = new Map<string, PrivateCalendarDeviceSession>();
/** Lazy, authenticated, UID-only composition. No QA app, personal DB or group key is used. */
export function openPrivateCalendarDevices(userId: string): PrivateCalendarDeviceSession {
  assertSharedIdentifier(userId); const { auth, firestore } = getSharingServices();
  const assertOwner = () => { if (auth.currentUser?.uid !== userId) throw new Error('本人用Calendarのアカウントが変わりました。'); };
  assertOwner(); const previous = sessions.get(userId); if (previous) return previous;
  const session = createPrivateCalendarDeviceSession({ userId, assertOwner, secrets: nativePrivateCalendarSecrets,
    roots: nativePrivateCalendarRootSetup(userId), intents: nativePrivateCalendarAuthorityIntents(userId),
    candidates: nativePrivateCalendarPairing(userId), outbox: nativePrivateCalendarKeyOutbox(userId), cache: nativePrivateCalendarCache(userId),
    cloud: createPrivateCalendarCloud(firestore, userId, () => auth.currentUser?.uid ?? null, nativePrivateCalendarCrypto),
    connections: { store: nativePrivateCalendarConnections(userId), crypto: nativePrivateCalendarCrypto,
      cloud: createPrivateCalendarConnectionCloud(firestore, userId, () => auth.currentUser?.uid ?? null) } });
  sessions.set(userId, session); return session;
}
