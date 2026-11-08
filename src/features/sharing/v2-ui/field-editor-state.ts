import { createDraftNavigation } from '../../settings/draft-navigation.ts';
import { canonicalJson, causallyPrecedes } from '../operations.ts';
import type { JsonValue } from '../operations';
import type { V2EditableField, V2FieldEdit, V2FieldSaveResult } from '../v2/field-edit';
import { createAutosaveQueue } from '../../settings/autosave-queue.ts';

export interface V2FieldCodec { format: (value: JsonValue | undefined) => JsonValue; parse: (raw: JsonValue) => JsonValue }
export interface V2FieldEditorInput {
  fields: Record<string, V2EditableField>; codecs: Record<string, V2FieldCodec>;
  save: (edits: V2FieldEdit[]) => Promise<V2FieldSaveResult>; onSaved: () => Promise<void>; delayMs?: number;
}
const ids = (field: V2EditableField) => field.candidates.map((candidate) => candidate.operationId);
const value = (field: V2EditableField) => field.kind === 'value' ? field.value : undefined;
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
/** A refresh must cover every known source; a smaller vector or a partial concurrent view cannot roll the editor back. */
function covers(next: V2EditableField, previous: V2EditableField) {
  return previous.candidates.every((source) => next.candidates.some((candidate) => candidate.operationId === source.operationId || causallyPrecedes(source, candidate)));
}

/** Text/choice drafts share the existing one-writer queue and keep each field's displayed causal base. */
export function createV2FieldEditorState(initial: V2FieldEditorInput) {
  let input = initial; let codecs = { ...initial.codecs }; let known = { ...initial.fields }; let token = 0; let refreshError: string | null = null;
  let raw = Object.fromEntries(Object.entries(known).map(([field, current]) => [field, initial.codecs[field].format(value(current))]));
  const bases = new Map(Object.entries(known).map(([field, current]) => [field, ids(current)])); const dirty = new Map<string, number>();
  const discardedFields = new Set<string>();
  const ownAcknowledgements = new Map<string, V2EditableField>();
  let errors: Record<string, string> = {}; const listeners = new Set<() => void>();
  type Batch = Record<string, { value: JsonValue; token: number; resolveOperationIds?: readonly string[] }>;
  const queue = createAutosaveQueue<Batch>({ delayMs: initial.delayMs, save: async (batch) => {
    const edits = Object.entries(batch).map(([field, change]): V2FieldEdit => ({ field, value: change.value, basisOperationIds: bases.get(field)!,
      ...(change.resolveOperationIds ? { resolveOperationIds: change.resolveOperationIds } : {}) }));
    const result = await input.save(edits);
    for (const [field, change] of Object.entries(batch)) {
      const acknowledged = result.fields[field];
      if (!acknowledged || acknowledged.kind !== 'value' || !same(acknowledged.value, change.value)) throw new Error('保存結果を確認できません。表示を更新してください。');
      bases.set(field, ids(acknowledged));
      ownAcknowledgements.set(field, acknowledged);
      if (covers(acknowledged, known[field])) known = { ...known, [field]: acknowledged };
      if (discardedFields.delete(field) && !dirty.has(field)) raw = { ...raw, [field]: codecs[field].format(value(known[field])) };
      if (dirty.get(field) === change.token) {
        dirty.delete(field);
        // Keep the user's raw newline/spacing after their own save; show a genuinely newer remote value instead.
        if (!same(value(known[field]), acknowledged.value)) raw = { ...raw, [field]: codecs[field].format(value(known[field])) };
      }
    }
    refreshError = null;
    try { await input.onSaved(); } catch { refreshError = '端末に保存済みです。表示を更新するため、もう一度開いてください。'; }
    publish();
  } });
  function discard(field?: string) {
    for (const key of field ? [field] : Object.keys(known)) {
      if (!known[key]) continue; discardedFields.add(key); dirty.delete(key); bases.set(key, ids(known[key])); queue.remove(key);
      raw = { ...raw, [key]: codecs[key].format(value(known[key])) }; const next = { ...errors }; delete next[key]; errors = next;
    }
    publish();
  }
  const navigation = createDraftNavigation({ flush: () => flush(), discard,
    invalid: () => Object.keys(errors).length > 0, failed: () => queue.getSnapshot().phase === 'error', publish: () => publish() });
  function state() { return { fields: known, raw, errors, status: queue.getSnapshot(), refreshError, ...navigation.state(), hasDraft: dirty.size > 0 }; }
  let snapshot = state();
  function publish() {
    const next = state();
    if (Object.entries(next).every(([key, value]) => value === snapshot[key as keyof typeof snapshot])) return;
    snapshot = next;
    for (const listener of listeners) try { listener(); } catch { /* Observers cannot discard a saved or pending draft. */ }
  }
  queue.subscribe(publish);
  function change(field: string, nextRaw: JsonValue, resolveOperationIds?: readonly string[], displayed?: V2EditableField, exact?: { value: JsonValue }) {
    if (!Object.hasOwn(known, field) || !Object.hasOwn(codecs, field)) throw new Error('変更する項目を確認してください。');
    if (!dirty.has(field) && displayed) {
      const own = ownAcknowledgements.get(field);
      bases.set(field, ids(own && same(value(own), value(known[field])) && covers(own, displayed) ? own : displayed));
    }
    discardedFields.delete(field); raw = { ...raw, [field]: nextRaw }; dirty.set(field, ++token);
    const nextErrors = { ...errors }; delete nextErrors[field];
    try {
      const parsed = exact ? exact.value : codecs[field].parse(nextRaw); const currentToken = token;
      if (known[field].kind === 'conflict' && resolveOperationIds === undefined) throw new Error('競合している候補を確認して解決してください。');
      queue.enqueue({ [field]: { value: parsed, token: currentToken, ...(resolveOperationIds ? { resolveOperationIds: [...resolveOperationIds] } : {}) } }, resolveOperationIds !== undefined);
    } catch (cause) { queue.remove(field); nextErrors[field] = cause instanceof Error ? cause.message : '入力内容を確認してください。'; }
    errors = nextErrors; publish();
  }
  const flush = async () => await queue.flush() && Object.keys(errors).length === 0;
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSnapshot: () => snapshot,
    updateInput(next: V2FieldEditorInput) {
      input = next; codecs = { ...codecs, ...next.codecs }; let changed = false;
      for (const [field, current] of Object.entries(next.fields)) {
        if (!known[field]) {
          known = { ...known, [field]: current }; raw = { ...raw, [field]: codecs[field].format(value(current)) };
          bases.set(field, ids(current)); changed = true; continue;
        }
        // Authenticated operation IDs bind immutable values; avoid copying long procedures on every render.
        if (known[field]?.kind === current.kind && same(ids(known[field]), ids(current))) continue;
        if (!covers(current, known[field])) continue;
        const previous = known[field]; known = { ...known, [field]: current }; changed = true;
        if (!dirty.has(field)) {
          bases.set(field, ids(current));
          if (!same(value(previous), value(current)) || previous.kind !== current.kind) raw = { ...raw, [field]: codecs[field].format(value(current)) };
        }
      }
      if (changed) publish();
    },
    // UI handlers pass the source actually rendered, even when a store update arrives before the next paint.
    change: (field: string, nextRaw: JsonValue, displayed?: V2EditableField) => change(field, nextRaw, undefined, displayed),
    changeWith(field: string, update: (raw: JsonValue) => JsonValue, displayed: V2EditableField, renderedRaw: JsonValue) {
      if (!Object.hasOwn(known, field)) throw new Error('変更する項目を確認してください。');
      const own = ownAcknowledgements.get(field);
      const useLatest = dirty.has(field) || same(ids(known[field]), ids(displayed))
        || own && same(value(own), value(known[field])) && covers(own, displayed);
      change(field, update(useLatest ? raw[field] : renderedRaw), undefined, displayed);
    },
    // Display formatting is lossy (null/empty sections and newlines inside a step); resolve the chosen signed value exactly.
    resolve: (field: string, candidateValue: JsonValue, observedOperationIds: readonly string[]) => change(field,
      codecs[field].format(candidateValue), observedOperationIds, undefined, { value: candidateValue }),
    flush, hasDraft: () => dirty.size > 0, isDirty: (field: string) => dirty.has(field),
    discard, resumeNavigation: navigation.resumeNavigation, navigateAfterSave: navigation.navigateAfterSave,

  };
}
