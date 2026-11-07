import type { LocalDate } from '../../domain/shared/types';
export interface ReplanRange { id: string; from: LocalDate; through: LocalDate; changed: boolean }
/** Connected intervals must be allocated together, even through an unchanged bridge. */
export function connectedReplanIds(rows: readonly ReplanRange[]): Set<string> {
  const sorted = [...rows].sort((a, b) => a.from.localeCompare(b.from) || a.through.localeCompare(b.through));
  const ids = new Set<string>();
  let component: ReplanRange[] = []; let through = ''; let changed = false;
  const finish = () => { if (changed) for (const row of component) ids.add(row.id); };
  for (const row of sorted) {
    if (component.length && row.from > through) { finish(); component = []; through = ''; changed = false; }
    component.push(row); if (row.through > through) through = row.through; changed ||= row.changed;
  }
  finish(); return ids;
}
