/** Human-readable local time, without exposing raw wire timestamps in product UI. */
export function applianceAnalysisDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '不明';
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
