/** Shared by persisted sync status and foreground recovery controls; never opens native UI. */
export function isGoogleAuthenticationError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  return error.status === 401
    || ['GoogleAccountMismatchError', 'GoogleSignInRequiredError', 'CalendarPermissionRequiredError'].includes(String(error.name))
    || ['invalid_grant', 'sign_in_required', 'google_account_mismatch'].includes(String(error.code).toLowerCase())
    || typeof error.message === 'string' && /\binvalid_grant\b|token (?:has been |is )?(?:expired|revoked)/iu.test(error.message);
}
