import type { Href, router as defaultRouter } from 'expo-router';

export const personalChoreSettings = '/settings?section=chores';

export function backOrReplace(router: Pick<typeof defaultRouter, 'canGoBack' | 'back' | 'replace'>, parent: Href) {
  if (router.canGoBack()) router.back();
  else router.replace(parent);
}
