import { createAutosaveQueue } from '../../settings/autosave-queue.ts';
import type { SharedOperation } from '../operations.ts';
import type { SharedChoreConfiguration } from '../v2/model.ts';
import type { V2ConfigurationFieldEdit, V2ConfigurationPatch } from '../v2/configuration-edit.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';

type Field = keyof V2ConfigurationPatch;
type PendingFields = Partial<Record<Field, { value: V2ConfigurationPatch[Field]; token: number; effectiveFrom: LocalDate }>>;
const fields: Field[] = ['policy', 'anchorDate', 'intervalDays', 'monthly', 'windowBeforeDays', 'windowAfterDays', 'active'];

/** Per-field displayed bases survive queue batching, in-flight edits and unrelated remote changes. */
export function createV2ConfigurationAutosave(input: { configuration: SharedChoreConfiguration; effectiveFrom: () => LocalDate;
  save: (edits: NonNullable<V2ConfigurationFieldEdit>[], from: LocalDate) => Promise<SharedOperation[]>;
  onSaved?: () => Promise<void>; onRefreshError?: (error: unknown) => void; delayMs?: number }) {
  let displayed = input.configuration; let token = 0;
  const bases = new Map(fields.map((field) => [field, displayed.ruleVersion])); const dirty = new Map<Field, number>();
  const queue = createAutosaveQueue<PendingFields>({ delayMs: input.delayMs, save: async (batch) => {
    const entries = Object.entries(batch) as [Field, NonNullable<PendingFields[Field]>][];
    const from = entries[0]?.[1].effectiveFrom;
    if (!from || entries.some(([, edit]) => edit.effectiveFrom !== from)) throw new Error('適用開始日が異なる変更は個別に保存してください。');
    const operations = await input.save(entries.map(([field, edit]) => ({ field, value: edit.value, baseRuleVersion: bases.get(field)! }) as NonNullable<V2ConfigurationFieldEdit>), from);
    const configuration = operations.find((operation) => operation.entityType === 'chorePolicy')?.payload.configuration as unknown as SharedChoreConfiguration | undefined;
    for (const [field, edit] of entries) {
      if (configuration) bases.set(field, configuration.ruleVersion);
      if (dirty.get(field) === edit.token) dirty.delete(field);
    }
    // A view refresh cannot turn a successful durable save into a failed/replayed business operation.
    try { await input.onSaved?.(); } catch (error) {
      try { input.onRefreshError?.(error); } catch { /* The persisted edit remains successful even if a view observer fails. */ }
    }
  } });
  return {
    subscribe: queue.subscribe, getSnapshot: queue.getSnapshot, flush: queue.flush,
    isDirty: (field: Field) => dirty.has(field),
    enqueue<Key extends Field>(field: Key, value: V2ConfigurationPatch[Key], immediate = false) {
      dirty.set(field, ++token); queue.enqueue({ [field]: { value, token, effectiveFrom: input.effectiveFrom() } }, immediate);
    },
    invalidate(field: Field) { dirty.set(field, ++token); queue.remove(field); },
    discard(field: Field) { dirty.delete(field); bases.set(field, displayed.ruleVersion); queue.remove(field); },
    updateDisplayed(configuration: SharedChoreConfiguration) {
      if (configuration.ruleVersion < displayed.ruleVersion) return;
      displayed = configuration;
      for (const field of fields) if (!dirty.has(field)) bases.set(field, configuration.ruleVersion);
    },
  };
}
