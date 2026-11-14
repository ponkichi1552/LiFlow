import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { LocalDate } from '../../domain/shared/types';
import { waitForInitialFrame } from '../planner/initial-display-gate';
import { createDemandWorker } from '../google-sync/demand-worker';

/** Navigation and editor commits never wait on Google. Only the global provider installs this observer. */
export function usePersonalGoogleSync(database: SQLiteDatabase, waitForInitialRead: () => Promise<void>) {
  const request = useRef<((from: LocalDate, through: LocalDate, options?: { refresh?: boolean }) => void) | null>(null);
  const earlyRange = useRef<[LocalDate, LocalDate, { refresh?: boolean }?] | null>(null);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined; let remoteRequested = false;
    const worker = createDemandWorker({ active: () => alive && AppState.currentState === 'active', run: async () => {
      const remote = remoteRequested; remoteRequested = false;
      try {
        await waitForInitialRead(); await waitForInitialFrame();
        if (!alive || AppState.currentState !== 'active') return false;
        const { nativePersonalGoogleCalendar } = await import('../../platform/google-calendar/personal-runtime');
        if (!alive) return false;
        const runtime = nativePersonalGoogleCalendar(database);
        if (!remote && !await runtime.hasPendingWork()) return false;
        const result = await runtime.sync();
        if (result.kind !== 'pending' && result.kind !== 'error') return false;
        remoteRequested ||= remote;
        const control = await runtime.readControl();
        if (!control.enabled || control.authRequired) return false;
        return control.retryAt > Date.now() ? { retryAt: control.retryAt } : true;
      } catch (error) { remoteRequested ||= remote; throw error; }
    } });
    const schedule = (localOnly = false) => { if (!localOnly) remoteRequested = true; clearTimeout(timer); timer = setTimeout(worker.request, 400); };
    request.current = (from, through, options) => {
      void import('../../platform/google-calendar/personal-runtime').then(async ({ nativePersonalGoogleCalendar }) => {
        if (!alive) return;
        const runtime = nativePersonalGoogleCalendar(database); const extended = await runtime.requestRange(from, through);
        if (!alive) return;
        if (extended) { schedule(); return; }
        if (options?.refresh) {
          const control = await runtime.readControl(); if (!alive || !control.enabled || control.authRequired) return;
          const at = Date.parse(control.lastSyncAt ?? '');
          if (!Number.isFinite(at) || at > Date.now() || Date.now() - at >= 30_000) schedule();
        }
      }).catch(() => { /* Offline range requests must not block a calendar gesture. */ });
    };
    if (earlyRange.current) { const range = earlyRange.current; earlyRange.current = null; request.current(...range); }
    schedule();
    const unsubscribe = subscribeLocalCalendar(database, change => { if (change === 'events') schedule(true); });
    const state = AppState.addEventListener('change', value => { if (value === 'active') schedule(); });
    return () => { alive = false; request.current = null; clearTimeout(timer); worker.stop(); unsubscribe(); state.remove(); };
  }, [database, waitForInitialRead]);
  return useCallback((from: LocalDate, through: LocalDate, options?: { refresh?: boolean }) => {
    if (request.current) request.current(from, through, options);
    else earlyRange.current = [from, through, options];
  }, []);
}
