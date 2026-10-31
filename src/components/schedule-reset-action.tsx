import { useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { AppButton, palette, typography } from './planner-ui';

export function ScheduleResetAction({ all = false, disabled = false, onReset }: { all?: boolean; disabled?: boolean; onReset(): Promise<unknown> }) {
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
  return <View><AppButton title={busy ? '初期値に戻しています…' : all ? 'すべてのスケジュールを初期値に戻す' : 'スケジュールを初期値に戻す'} variant="quiet" compact disabled={disabled || busy} onPress={press} />
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error}</Text> : null}</View>;
}
