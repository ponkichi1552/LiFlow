import { useNavigation, useRoute } from 'expo-router';
import { useCallback, useLayoutEffect, useRef } from 'react';
import type { AnalysisWork } from './analysis-work';

/** Reset the manual stack after a tab switch only once the PDF has a durable work record. */
export function useAnalysisListOnTabReturn(work: AnalysisWork | null | undefined, enabled = true) {
  const navigation = useNavigation();
  const { key } = useRoute();
  const tab = enabled ? navigation.getParent?.() : undefined;
  const pending = useRef(false);
  const submission = useRef<{ left: boolean } | null>(null);
  const state = work?.state;
  useLayoutEffect(() => {
    if (work !== undefined) pending.current = state === 'pending';
  }, [work, state]);

  const showLibrary = useCallback(() => {
    const stack = navigation.getState?.();
    if (stack?.type !== 'stack' || stack.routes[0]?.name !== 'index' || stack.routes[stack.index]?.key !== key) return;
    navigation.dispatch({ type: 'POP_TO_TOP', target: stack.key });
  }, [navigation, key]);

  const otherTabSelected = useCallback(() => {
    const state = tab?.getState();
    return state?.type === 'tab' && state.routes[state.index]?.name !== 'manual';
  }, [tab]);
  useLayoutEffect(() => tab?.addListener('blur', () => {
    if (!otherTabSelected()) return;
    if (submission.current) submission.current.left = true;
    else if (pending.current) showLibrary();
  }), [tab, otherTabSelected, showLibrary]);

  return async (start: () => Promise<string>) => {
    const attempt = { left: false };
    submission.current = attempt;
    try {
      const result = await start();
      pending.current = true;
      // Dispatch to the retained manual stack, without changing the active tab.
      if (attempt.left || otherTabSelected()) showLibrary();
      return result;
    } finally { submission.current = null; }
  };
}
