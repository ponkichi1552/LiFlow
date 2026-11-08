/** Navigation never waits for autosave. Invalid/failed input is abandoned on departure;
 * valid queued changes get one normal save attempt, without keeping the user on the page. */
export function createDraftNavigation(input: {
  flush(): Promise<boolean>; discard(): void; invalid(): boolean; failed(): boolean; publish(): void;
}) {
  let leaving = false; let removalAllowed = false; let generation = 0;
  return {
    state: () => ({ leaving, removalAllowed, navigationBlocked: false }),
    resumeNavigation() { generation++; leaving = false; removalAllowed = false; input.publish(); },
    async navigateAfterSave(navigate: () => void): Promise<boolean> {
      if (leaving) return false;
      const departure = ++generation; leaving = true; removalAllowed = true;
      if (input.invalid() || input.failed()) input.discard();
      input.publish();
      // Start the retained writer, but do not await storage, refresh or a network retry.
      void input.flush().then(saved => {
        if (!saved && departure === generation && leaving) input.discard();
      }).catch(() => { if (departure === generation && leaving) input.discard(); });
      try { navigate(); return true; }
      catch (cause) { leaving = false; removalAllowed = false; generation++; input.publish(); throw cause; }
    },
  };
}
