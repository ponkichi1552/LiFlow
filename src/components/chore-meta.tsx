import { StyleSheet, Text } from 'react-native';
import type { ChoreDefinition, FrequencyMode } from '../domain/chores/types';
import { palette, typography } from './planner-ui';
import { choreCadenceLabel } from '../domain/chores/cycle-policy';

export function ChoreMeta({ chore, mode, cadenceLabel }: { chore: ChoreDefinition; mode: FrequencyMode; cadenceLabel?: string }) {
  return <Text style={styles.meta}>{cadenceLabel ?? choreCadenceLabel(chore, mode)}
    {chore.estimatedMinutes ? ` · 目安 約${chore.estimatedMinutes}分` : ' · 所要時間は未登録'}</Text>;
}
const styles = StyleSheet.create({ meta: { ...typography.label, color: palette.muted, fontWeight: '500' } });
