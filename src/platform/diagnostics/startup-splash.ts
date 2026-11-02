let splash: { setOptions(options: { duration: number; fade: boolean }): void; preventAutoHideAsync(): Promise<unknown>; hideAsync(): Promise<unknown> } | undefined;
let finishing = false;
// Only the foreground Router layout supplies native APIs; workers and domain readers have no native splash side effect.
export function prepareStartupDisplay(native: NonNullable<typeof splash>) {
  splash = native;
  native.setOptions({ duration: 0, fade: false });
  void native.preventAutoHideAsync().catch(() => undefined);
}
/** Reveal a laid-out usable surface directly; no intermediate loading card or added animation delay. */
export function finishStartupDisplay() {
  if (finishing || !splash) return; finishing = true;
  // The native splash may suppress drawing (including animation frames). The ready
  // surface's layout already ran; waiting for another frame can prevent hiding forever.
  void splash.hideAsync().catch(() => { finishing = false; });
}
