import type { SQLiteDatabase } from 'expo-sqlite';
import { activatePersonalGoogleTaskAccount } from '../../platform/storage/google-account-archive';
import { getCurrentGoogleSubject, GoogleSignInRequiredError, selectGoogleSyncAccount } from '../../platform/google-tasks/google-sign-in-gateway';
import { GoogleAccountMismatchError } from './account-binding';
import { withGoogleSyncOperation } from './operation-lock';
import { createGoogleOperationBudget, withinGoogleOperationBudget } from './operation-budget';
import { notifyGoogleAccountChanged } from './account-change-events';

async function activate(database: SQLiteDatabase, expected?: { google: string; firebase?: string | null }) {
  const budget = createGoogleOperationBudget(15_000);
  try {
    const subject = await withinGoogleOperationBudget(budget, getCurrentGoogleSubject);
    if (!subject) throw new GoogleSignInRequiredError();
    if (expected && expected.google !== subject) throw new GoogleAccountMismatchError();
    const guard = async () => {
      if (await withinGoogleOperationBudget(budget, getCurrentGoogleSubject) !== subject) throw new GoogleAccountMismatchError();
      if (expected && expected.firebase !== undefined) {
        const { sharingSessionUser } = await import('../../platform/sharing/workspaces');
        const user = await withinGoogleOperationBudget(budget, sharingSessionUser);
        if ((user?.uid ?? null) !== expected.firebase) throw new GoogleAccountMismatchError();
      }
    };
    // Only readonly native waits are raced. The SQLite transaction must finish its commit/rollback.
    await activatePersonalGoogleTaskAccount(database, subject, guard);
  } finally { budget.close(); }
}

/** Only an explicit foreground connection/account choice may replace the active local binding. */
export function activateCurrentGoogleTaskAccount(database: SQLiteDatabase, expectedSubject?: string) {
  return withGoogleSyncOperation(() => activate(database, expectedSubject ? { google: expectedSubject } : undefined), 'googleAccount.activate');
}

export async function changeGoogleAccount(database: SQLiteDatabase) {
  const { sharingSessionUser } = await import('../../platform/sharing/workspaces');
  const previous = await sharingSessionUser();
  let google: string | undefined; let firebase: string | null = null;
  if (previous) {
    const { switchSharingGoogleAccount } = await import('../../platform/sharing/auth');
    const user = await switchSharingGoogleAccount();
    google = user.providerData.find(provider => provider.providerId === 'google.com')?.uid; firebase = user.uid;
  } else {
    google = (await selectGoogleSyncAccount()).subject;
  }
  if (!google) throw new GoogleAccountMismatchError();
  // Let already-running work finish against its old binding before saving the new account.
  const selected = google;
  await withGoogleSyncOperation(() => activate(database, { google: selected, firebase }), 'googleAccount.activate');
  notifyGoogleAccountChanged(database);
  return selected;
}

/** Stop automatic Google work and forget credentials; mappings, pending changes and remote data remain. */
export async function signOutGoogleAccount(database: SQLiteDatabase) {
  const { sharingSessionUser } = await import('../../platform/sharing/workspaces');
  const userId = (await sharingSessionUser())?.uid ?? null;
  const assertOwner = async () => { if (((await sharingSessionUser())?.uid ?? null) !== userId) throw new GoogleAccountMismatchError(); };
  const { loadGoogleSyncState } = await import('../../platform/storage/repository');
  const { configurePersonalGoogleTaskSync } = await import('./coordinator');
  await assertOwner();
  if ((await loadGoogleSyncState(database))?.enabled) await configurePersonalGoogleTaskSync(database, false);
  await assertOwner();
  const { readPersonalGoogleCalendarControl, disablePersonalGoogleCalendar } = await import('../../platform/storage/personal-google-calendar');
  const calendar = await readPersonalGoogleCalendarControl(database);
  if (calendar.enabled) await disablePersonalGoogleCalendar(database, calendar);
  await withGoogleSyncOperation(async () => {
    await assertOwner();
    const { signOutGoogleSyncAccount } = await import('../../platform/google-tasks/google-sign-in-gateway');
    await signOutGoogleSyncAccount(); await assertOwner();
    if (userId) {
      const { signOutSharing } = await import('../../platform/sharing/auth');
      await signOutSharing({ expectedUserId: userId });
    }
  }, 'googleAccount.signOut');
  notifyGoogleAccountChanged(database);
}
