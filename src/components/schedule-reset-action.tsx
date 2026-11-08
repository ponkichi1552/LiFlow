import { useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { palette, typography } from './planner-ui';
import { SettingsAction } from './settings-controls';
import { plannerColorsForScheme } from './planner-theme';

export function ScheduleResetAction({ all = false, disabled = false, onReset, accessibilityLabel }: { all?: boolean; disabled?: boolean; onReset(): Promise<unknown>; accessibilityLabel?: string }) {
  const colors = plannerColorsForScheme(useColorScheme());
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const reset = async () => {
    if (running.current) return; running.current = true; setBusy(true); setError(null);
    try { await onReset(); } catch (cause) { setError(cause instanceof Error ? cause.message : '初期値に戻せませんでした。'); }
    finally { running.current = false; setBusy(false); }
  };
  const press = () => {
    if (!all) { void reset(); return; }
    Alert.alert('すべての家事のスケジュールを戻しますか？', '周期・負荷・実施期間などを初期値に戻します。有効・無効、名前・手順、履歴、担当者は保持します。',
      [{ text: 'キャンセル', style: 'cancel' }, { text: '初期値に戻す', onPress: () => void reset() }]);
  };
  const label = busy ? '初期値に戻しています…' : accessibilityLabel ?? (all ? 'すべてのスケジュールを初期値に戻す' : 'スケジュールを初期値に戻す');
  return <View>{!all ? <View style={styles.row}><Text style={[styles.rowLabel, { color: colors.ink }]}>初期設定</Text><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy }}
    disabled={disabled || busy} onPress={press} style={({ pressed }) => [styles.outlined, { borderColor: colors.inputBorder, backgroundColor: colors.surface }, pressed && { backgroundColor: colors.accentSoft }, (disabled || busy) && { opacity: 0.5 }]}>
    <Text style={[styles.label, { color: colors.accent }]}>{busy ? '処理中…' : '戻す'}</Text>
  </Pressable></View> : <SettingsAction title={label} placement="page" disabled={disabled || busy} onPress={press} />}
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error}</Text> : null}</View>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 60, gap: 10, paddingVertical: 8 },
  rowLabel: { ...typography.body },
  outlined: { minHeight: 44, minWidth: 72, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 },
  label: { ...typography.body },
});
