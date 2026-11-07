import { useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Host, Picker } from '@expo/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';

/** Native wheel on iOS; a directly selectable list on Android. */
export function CalendarOptionPicker({ title, value, options, onSelect, onClose, onCustom }: {
  title: string; value: string; options: readonly { value: string; label: string }[];
  onSelect: (value: string) => void; onClose: () => void; onCustom?: () => void;
}) {
  const [selected, setSelected] = useState(value); const [initialValue] = useState(value); const scheme = useColorScheme(); const insets = useSafeAreaInsets();
  const latest = useRef(value); const closed = useRef(false);
  const close = () => { if (closed.current) return false; closed.current = true; onClose(); return true; };
  const choose = (next: string) => {
    if (closed.current || !options.some(option => option.value === next)) return;
    latest.current = next; setSelected(next);
    if (next === 'custom' && onCustom) { if (close()) onCustom(); return; }
    onSelect(next); if (Platform.OS !== 'ios') close();
  };
  return <Modal transparent animationType="fade" onRequestClose={() => { close(); }}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}の選択を閉じる`} onPress={close} style={StyleSheet.absoluteFill} />
    <View style={[styles.panel, { paddingBottom: Math.max(12, insets.bottom) }]}>
      <View style={styles.header}><Text style={styles.title}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${title}の選択を完了`} onPress={() => { if (close() && latest.current === 'custom') onCustom?.(); }} style={styles.done}><Text style={styles.action}>{selected === 'custom' && onCustom ? '次へ' : '完了'}</Text></Pressable></View>
      {Platform.OS === 'ios' ? <Host colorScheme={scheme === 'dark' ? 'dark' : 'light'} seedColor={palette.accent} style={styles.wheel}>
        {/* Feeding intermediate JS events back into SwiftUI interrupts its wheel motion. */}
        <Picker testID="calendar-option-wheel" appearance="wheel" selectedValue={initialValue} onValueChange={choose}>{options.map(option => <Picker.Item key={option.value} value={option.value} label={option.label} />)}</Picker>
      </Host> : <ScrollView style={styles.list}>{options.map(option => <Pressable key={option.value} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ selected: selected === option.value }} onPress={() => choose(option.value)} style={[styles.option, selected === option.value && styles.selected]}>
        <Text style={styles.optionText}>{option.label}</Text>{selected === option.value ? <Text style={styles.action}>✓</Text> : null}</Pressable>)}</ScrollView>}
    </View>
  </View></Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay }, panel: { backgroundColor: palette.elevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', maxHeight: '75%' },
  header: { minHeight: 48, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, title: { ...typography.subheading, color: palette.ink, fontWeight: '600', flex: 1 },
  done: { minHeight: 44, minWidth: 56, alignItems: 'flex-end', justifyContent: 'center' }, action: { ...typography.body, color: palette.accent }, wheel: { height: 216, width: '100%' }, list: { maxHeight: 380 },
  option: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, optionText: { ...typography.body, color: palette.ink, flex: 1 }, selected: { backgroundColor: palette.accentSoft },
});
