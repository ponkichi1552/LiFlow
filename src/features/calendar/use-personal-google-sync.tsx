import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { LocalDate } from '../../domain/shared/types';

/** Navigation and editor commits never wait on Google. Only the global provider installs this observer. */
export function usePersonalGoogleSync(database: SQLiteDatabase) {
  const request = useRef<((from: LocalDate, through: LocalDate) => void) | null>(null);
  useEffect(() => {
    let alive = true; let pending = false; let running = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (!alive || AppState.currentState !== 'active') return;
      if (running) { pending = true; return; } running = true;
      try {
        const { nativePersonalGoogleCalendar } = await import('../../platform/google-calendar/personal-runtime');
        if (alive) { const result = await nativePersonalGoogleCalendar(database).sync(); if (result.kind === 'pending' && !result.retryAt) pending = true; }
      } catch { /* The coordinator retains state and retries; a network error must not block a screen. */ }
      finally { running = false; if (pending && alive) { pending = false; schedule(); } }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void run(), 400); };
    request.current = (from, through) => {
      void import('../../platform/google-calendar/personal-runtime').then(async ({ nativePersonalGoogleCalendar }) => {
        if (alive && await nativePersonalGoogleCalendar(database).requestRange(from, through)) schedule();
      }).catch(() => { /* Offline range requests must not block a calendar gesture. */ });
    };
    schedule();
    const unsubscribe = subscribeLocalCalendar(database, change => { if (change === 'events') schedule(); });
    const state = AppState.addEventListener('change', value => { if (value === 'active') schedule(); });
    const periodic = setInterval(() => void run(), 10 * 60_000);
    return () => { alive = false; request.current = null; clearTimeout(timer); clearInterval(periodic); unsubscribe(); state.remove(); };
  }, [database]);
  return useCallback((from: LocalDate, through: LocalDate) => request.current?.(from, through), []);
}
