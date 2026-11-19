import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { NumberInputField } from '@/components/number-input-field';
import { palette, typography } from '@/components/planner-ui';
import { SettingsAction, SettingsPanel } from '@/components/settings-controls';
import { parseSettingInteger } from '@/domain/chores/settings-patch';
import { CalendarSheetHeader } from '@/features/calendar/calendar-sheet-header';
import { ApplianceTaskCycleConflict } from './persistence-policy';

export function ApplianceCycleEditor({ taskName, initialDays, onClose, onSave, onReload }: {
  taskName: string;
  initialDays?: number;
  onClose(): void;
  onSave(days: number): Promise<void>;
  onReload?(): void;
}) {
  const [text, setText] = useState(initialDays?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const lock = useRef(false);
  const days = parseSettingInteger(text, 1, 3650);
  const canSave = days !== undefined && days !== initialDays && !conflict && !busy;
  const close = () => { if (!lock.current) onClose(); };
  const save = async () => {
    if (!canSave || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try { await onSave(days); onClose(); }
    catch (cause) {
      setConflict(cause instanceof ApplianceTaskCycleConflict);
      setError(cause instanceof Error ? cause.message : '周期を保存できませんでした。');
    } finally { lock.current = false; setBusy(false); }
  };
  const validation = text.trim() && days === undefined ? '1〜3650日で入力してください。' : null;
  return <Modal visible transparent animationType="fade" onRequestClose={close}>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <SafeAreaView edges={['bottom']} style={styles.sheet} accessibilityViewIsModal>
        <CalendarSheetHeader title={initialDays === undefined ? '周期を設定' : '周期を変更'} onClose={close}
          closeLabel="周期の編集を閉じる" saveLabel="周期を保存" onSave={() => void save()} busy={busy} saveDisabled={!canSave} />
        <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>{taskName}</Text>
          <SettingsPanel><View style={styles.row}>
            <Text style={styles.label}>実施周期</Text>
            <NumberInputField accessibilityLabel="実施周期" value={text} placeholder="未設定" editable={!busy && !conflict}
              onChangeText={value => { setText(value); setError(undefined); }} suffix="日" />
          </View></SettingsPanel>
          {error || validation ? <Text accessibilityRole="alert" style={styles.error}>{error ?? validation}</Text> : null}
          {conflict && onReload ? <SettingsAction title="家電の情報を読み直す" placement="page" onPress={() => { onClose(); onReload(); }} /> : null}
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay },
  sheet: { width: '100%', maxWidth: 640, maxHeight: '82%', alignSelf: 'center', backgroundColor: palette.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  scroll: { flexGrow: 0 },
  content: { gap: 14, paddingHorizontal: 18, paddingVertical: 18 },
  title: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { ...typography.body, color: palette.ink, flex: 1 },
  error: { ...typography.caption, color: palette.warning },
});
