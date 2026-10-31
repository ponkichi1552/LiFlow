import { useEffect, useRef, useState } from 'react';

/** One small Undo, retained after a failed reversal and safe against a newer action. */
export function useTransientUndo() {
  const [item, setItem] = useState<{ message: string; undo: () => Promise<unknown> } | null>(null);
  const latest = useRef(item); const running = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!item || busy || error) return; const timer = setTimeout(() => { if (latest.current === item) { latest.current = null; setItem(null); } }, 6500); return () => clearTimeout(timer); }, [busy, error, item]);
  return { item, busy, error, remember(message: string, undo: () => Promise<unknown>) { const value = { message, undo }; latest.current = value; setItem(value); setError(null); },
    async undo() {
      const current = latest.current; if (!current || running.current || !alive.current) return;
      running.current = true; setBusy(true); setError(null);
      try { await current.undo(); if (latest.current === current) { latest.current = null; if (alive.current) setItem(null); } }
      catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '元に戻せませんでした。再試行してください。'); }
      finally { running.current = false; if (alive.current) setBusy(false); }
    },
  };
}
