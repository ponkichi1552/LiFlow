const googleSignInCallback = /^com\.googleusercontent\.apps\.[a-z0-9-]+:\/{1,3}(?:oauth2?redirect|oauth2callback|emmcallback)(?:[?#]|$)/iu;

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  // The native Google Sign-In SDK handles these URLs before Expo forwards them.
  return googleSignInCallback.test(path) ? null : path;
}
