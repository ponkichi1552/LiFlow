/** Local opt-in measurement; no planner contents, account IDs or network requests. */
const started = performance.now();
let displayed = false;
if (process.env.EXPO_PUBLIC_LIFLOW_STARTUP_TRACE === '1') console.info(`[LiFlow startup] javascript.begin (at ${Math.round(started)}ms)`);
export function recordHomeFirstLayout() {
  if (displayed || process.env.EXPO_PUBLIC_LIFLOW_STARTUP_TRACE !== '1') return;
  displayed = true;
  requestAnimationFrame(() => console.info(`[LiFlow startup] home.firstFrame: ${Math.round(performance.now() - started)}ms after JS begin (at ${Math.round(performance.now())}ms)`));
}
