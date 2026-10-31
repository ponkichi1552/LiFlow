import { useEffect } from 'react';
import { useRetainedV2Draft } from './settings-draft-cache';
import { createV2FieldEditorState } from './field-editor-state';
import type { V2FieldEditorInput } from './field-editor-state';
import { useV2DraftLifecycle } from './use-draft-lifecycle';
import type { JsonValue } from '../operations';

export function useV2FieldAutosave(input: V2FieldEditorInput, cacheKey?: string) {
  const store = useRetainedV2Draft(cacheKey, () => createV2FieldEditorState(input));
  useEffect(() => { store.updateInput(input); }, [input, store]);
  const { snapshot, navigateAfterSave } = useV2DraftLifecycle(store);
  return { ...store, ...snapshot, hasDraft: store.hasDraft, navigateAfterSave,
    change: (field: string, raw: JsonValue) => store.change(field, raw, snapshot.fields[field]),
    changeWith: (field: string, update: (raw: JsonValue) => JsonValue) => store.changeWith(field, update, snapshot.fields[field], snapshot.raw[field]),
    resolve: (field: string, candidate: JsonValue) => store.resolve(field, candidate, snapshot.fields[field].candidates.map((source) => source.operationId)),
  };
}
