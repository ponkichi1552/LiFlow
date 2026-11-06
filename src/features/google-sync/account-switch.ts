import type { SQLiteDatabase } from 'expo-sqlite';
import { activatePersonalGoogleTaskAccount } from '../../platform/storage/google-account-archive';
import { getCurrentGoogleSubject, GoogleSignInRequiredError } from '../../platform/google-tasks/google-sign-in-gateway';
import { GoogleAccountMismatchError } from './account-binding';
import { withGoogleSyncOperation } from './operation-lock';
import { createGoogleOperationBudget, withinGoogleOperationBudget } from './operation-budget';
import { notifyGoogleAccountChanged } from './account-change-events';

async function activate(database: SQLiteDatabase, expected?: { google: string; firebase: string }) {
  const budget = createGoogleOperationBudget(15_000);
  try {
    const subject = await withinGoogleOperationBudget(budget, getCurrentGoogleSubject);
    if (!subject) throw new GoogleSignInRequiredError();
    if (expected && expected.google !== subject) throw new GoogleAccountMismatchError();
    const guard = async () => {
      if (await withinGoogleOperationBudget(budget, getCurrentGoogleSubject) !== subject) throw new GoogleAccountMismatchError();
      if (expected) {
        const { sharingSessionUser } = await import('../../platform/sharing/workspaces');
        const user = await withinGoogleOperationBudget(budget, sharingSessionUser);
        if (user?.uid !== expected.firebase) throw new GoogleAccountMismatchError();
      }
    };
    // Only readonly native waits are raced. The SQLite transaction must finish its commit/rollback.
    await activatePersonalGoogleTaskAccount(database, subject, guard);
  } finally { budget.close(); }
}

/** Only an explicit foreground connection/account choice may replace the active local binding. */
export function activateCurrentGoogleTaskAccount(database: SQLiteDatabase) {
  return withGoogleSyncOperation(() => activate(database), 'googleAccount.activate');
}

export async function changeGoogleAccount(database: SQLiteDatabase) {
  const { switchSharingGoogleAccount } = await import('../../platform/sharing/auth');
  const user = await switchSharingGoogleAccount();
  const google = user.providerData.find(provider => provider.providerId === 'google.com')?.uid;
  if (!google) throw new GoogleAccountMismatchError();
  // Let already-running work finish against its old binding before saving the new account.
  await withGoogleSyncOperation(() => activate(database, { google, firebase: user.uid }), 'googleAccount.activate');
  notifyGoogleAccountChanged(database);
}
