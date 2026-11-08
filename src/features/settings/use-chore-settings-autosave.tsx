import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import type { ChoreSettingsPatch } from '@/domain/chores/settings-patch';
import { parseSettingInteger } from '@/domain/chores/settings-patch';
import { createChoreSettingsEditor } from './chore-settings-editor';
import type { ChoreSettingsEditor } from './chore-settings-editor';

export function useChoreSettingsAutosave(chore: ChoreDefinition, mode: FrequencyMode,
  savePatch: (patch: ChoreSettingsPatch, base: ChoreDefinition) => Promise<void>, provided?: ChoreSettingsEditor) {
  const [own] = useState(() => provided ?? createChoreSettingsEditor(chore, mode, savePatch));
  const editor = provided ?? own;
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useFocusEffect(useCallback(() => {
    editor.resumeNavigation(); return () => { if (provided) void editor.flush(); else void editor.navigateAfterSave(() => {}); };
  }, [editor, provided]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => { if (value !== 'active') void editor.flush(); });
    return () => { subscription.remove(); if (provided) void editor.flush(); else void editor.navigateAfterSave(() => {}); };
  }, [editor, provided]);
  return {
    ...editor, ...state,
    cycleError: state.draft.cycleText.trim() && parseSettingInteger(state.draft.cycleText, 1, Number.MAX_SAFE_INTEGER) === undefined ? '周期は1日以上の整数で入力してください。' : null,
    radiusError: parseSettingInteger(state.draft.radiusText, 0, 14) === undefined ? '期間幅は±0〜±14日の整数で入力してください。' : null,
  };
}
