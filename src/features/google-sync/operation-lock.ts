import { traceStartup } from '../../platform/diagnostics/startup-timing.ts';

let operationTail: Promise<unknown> = Promise.resolve();

/** Settings and the existing sync promise share a queue; no overlapping schedule mutations. */
export function withGoogleSyncOperation<T>(operation: () => Promise<T>, phase = 'googleOperation'): Promise<T> {
  const preceding = operationTail;
  const pending = traceStartup(`${phase}.wait`, () => preceding).then(() => traceStartup(`${phase}.run`, operation));
  operationTail = pending.then(() => undefined, () => undefined);
  return pending;
}
