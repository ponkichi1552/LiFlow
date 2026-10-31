let splash: { preventAutoHideAsync(): Promise<unknown>; hideAsync(): Promise<unknown> } | undefined;
let finishing = false;
// Only the foreground Router layout supplies native APIs; workers and domain readers have no native splash side effect.
export function prepareStartupDisplay(native: NonNullable<typeof splash>) {
  splash = native;
  void native.preventAutoHideAsync().catch(() => undefined);
}
/** Reveal a laid-out usable surface directly; no intermediate loading card or added animation delay. */
export function finishStartupDisplay() {
  if (finishing || !splash) return; finishing = true;
  const hide = () => { void splash!.hideAsync().catch(() => { finishing = false; }); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(hide); else hide();
}
