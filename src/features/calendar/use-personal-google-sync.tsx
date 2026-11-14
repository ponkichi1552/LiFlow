import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { LocalDate } from '../../domain/shared/types';
import { waitForInitialFrame } from '../planner/initial-display-gate';
import { createDemandWorker } from '../google-sync/demand-worker';

/** Navigation and editor commits never wait on Google. Only the global provider installs this observer. */
export function usePersonalGoogleSync(database: SQLiteDatabase, waitForInitialRead: () => Promise<void>) {
  const request = useRef<((from: LocalDate, through: LocalDate) => void) | null>(null);
  const earlyRange = useRef<[LocalDate, LocalDate] | null>(null);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const worker = createDemandWorker({ active: () => alive && AppState.currentState === 'active', run: async () => {
        await waitForInitialRead(); await waitForInitialFrame();
        if (!alive || AppState.currentState !== 'active') return false;
        const { nativePersonalGoogleCalendar } = await import('../../platform/google-calendar/personal-runtime');
        if (!alive) return false;
        const runtime = nativePersonalGoogleCalendar(database);
        const result = await runtime.sync();
        if (result.kind !== 'pending' && result.kind !== 'error') return false;
        const control = await runtime.readControl();
        if (!control.enabled || control.authRequired) return false;
        return control.retryAt > Date.now() ? { retryAt: control.retryAt } : true;
    } });
    const schedule = () => { clearTimeout(timer); timer = setTimeout(worker.request, 400); };
    request.current = (from, through) => {
      void import('../../platform/google-calendar/personal-runtime').then(async ({ nativePersonalGoogleCalendar }) => {
        if (alive && await nativePersonalGoogleCalendar(database).requestRange(from, through)) schedule();
      }).catch(() => { /* Offline range requests must not block a calendar gesture. */ });
    };
    if (earlyRange.current) { const range = earlyRange.current; earlyRange.current = null; request.current(...range); }
    schedule();
    const unsubscribe = subscribeLocalCalendar(database, change => { if (change === 'events') schedule(); });
    const state = AppState.addEventListener('change', value => { if (value === 'active') schedule(); });
    return () => { alive = false; request.current = null; clearTimeout(timer); worker.stop(); unsubscribe(); state.remove(); };
  }, [database, waitForInitialRead]);
  return useCallback((from: LocalDate, through: LocalDate) => {
    if (request.current) request.current(from, through);
    else earlyRange.current = [from, through];
  }, []);
}
