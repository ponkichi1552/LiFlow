import { personalGoogleDigest } from '../../platform/storage/personal-google-store.ts';

/** Persist hashes rather than opaque provider tokens; an unfinished scan survives app restarts. */
export function advanceCalendarPageHistory(saved: string | null | undefined, current: string | null | undefined, next: string | undefined): string {
  if (!next) return '[]';
  const history: unknown = current ? JSON.parse(saved ?? '[]') : [];
  if (!Array.isArray(history) || history.length >= 10_000 || history.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) throw new Error('Googleの取得位置を読み直してください。');
  const digest = personalGoogleDigest(next);
  if (next === current || history.includes(digest)) throw new Error('Googleの取得位置が繰り返されています。変更は保持しています。');
  return JSON.stringify([...history, digest]);
}
