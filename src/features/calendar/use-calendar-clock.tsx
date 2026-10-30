import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

const MINUTE_MS = 60_000;
const currentMinute = () => Math.floor(Date.now() / MINUTE_MS);
const withoutSubscription = () => () => {};

/** A minute snapshot is fresh on entry, before the timeline's first layout. */
export function subscribeCalendarClock(changed: () => void) {
  let live = true;
  let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    if (live && active) timer = setTimeout(tick, MINUTE_MS - Date.now() % MINUTE_MS);
  };
  const tick = () => {
    if (!live || !active) return;
    changed(); arm();
  };
  const listener = AppState.addEventListener('change', state => {
    active = state === 'active';
    if (active) tick(); else clearTimeout(timer);
  });
  arm();
  return () => { live = false; clearTimeout(timer); listener.remove(); };
}

export function useCalendarClock(enabled: boolean) {
  const minute = useSyncExternalStore(enabled ? subscribeCalendarClock : withoutSubscription, currentMinute, currentMinute);
  return new Date(minute * MINUTE_MS);
}
