import { AdaptiveOwnerInputsChangedError } from './adaptive-owner-inputs.ts';

export const plannerReadRetryDelays = [400, 1_200, 3_000] as const;

/** Retry only the display read after the caller has already committed a change. */
export function retryPlannerDisplayRead(read: () => Promise<boolean>, settled: (recovered: boolean) => void) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (attempt: number) => {
    timer = setTimeout(async () => {
      const recovered = await Promise.resolve().then(read).catch(() => false);
      if (cancelled) return;
      if (recovered || attempt === plannerReadRetryDelays.length - 1) settled(recovered);
      else schedule(attempt + 1);
    }, plannerReadRetryDelays[attempt]);
  };
  schedule(0);
  return () => { cancelled = true; clearTimeout(timer); };
}

export class PlannerInputsChangedError extends Error {
  constructor() { super('別の処理で家事が更新されました。表示を読み直してください。'); }
}

/** SQLite can be momentarily locked by another connection or unavailable during resume. */
export function isTransientPlannerRead(error: unknown) {
  if (error instanceof PlannerInputsChangedError || error instanceof AdaptiveOwnerInputsChangedError) return true;
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return /\bSQLITE_(?:BUSY|LOCKED|CANTOPEN|IOERR_BLOCKED)(?:_\w+)?\b|database (?:table )?is locked|unable to open database file/iu.test(`${code} ${error.message}`);
}
