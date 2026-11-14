import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import type { ReactNode } from 'react';
import type { EventDraft } from './events';
import type { ChoreClocks } from './chore-clock-input';
import type { CalendarChoreInput } from './chore-registration-input';

export type CalendarChoreEntry = {
  id?: string; value: EventDraft; onChange(value: EventDraft): void; onChoose?(): void; details?: ReactNode; titleEditable?: boolean;
  detailsExpanded?: boolean; onDetailsToggle?(): void;
  clocks?: ChoreClocks & { onChange(field: 'start' | 'end', minute: number): void };
  readInput?(): CalendarChoreInput;
};
export type CalendarSheetForm = { content: ReactNode; onSave?: () => void; disabled: boolean; busy: boolean; entry?: CalendarChoreEntry };

/** A React boundary keeps render slots separate from the event handlers they receive. */
export function CalendarSheetContent<T>({ render, form }: { render(form: T): ReactNode; form: T }) {
  return render(form);
}

/** Appointment and chore entry share one sheet and the same close/save positions. */
export function CalendarSheetHeader({ title, onClose, onSave, closeTitle = '閉じる', closeLabel = '予定の編集を閉じる', saveTitle = '保存', saveLabel = '予定を保存', busy = false, saveDisabled = false, closeExpanded }: {
  title: string; onClose(): void; onSave?(): void; closeTitle?: string; closeLabel?: string;
  saveTitle?: string; saveLabel?: string; busy?: boolean; saveDisabled?: boolean; closeExpanded?: boolean;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  return <View style={styles.header}>
    <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} accessibilityState={closeExpanded === undefined ? undefined : { expanded: closeExpanded }} disabled={busy} onPress={onClose} style={styles.button}><Text style={[styles.action, busy && styles.disabled]}>{closeTitle}</Text></Pressable>
    <Text numberOfLines={1} adjustsFontSizeToFit style={styles.heading}>{title}</Text>
    {onSave ? <Pressable accessibilityRole="button" accessibilityLabel={saveLabel} disabled={busy || saveDisabled} onPress={onSave} style={[styles.button, styles.save, (busy || saveDisabled) && styles.saveDisabled]}><Text style={[styles.action, styles.saveLabel, (busy || saveDisabled) && styles.saveLabelDisabled]}>{busy ? '保存中' : saveTitle}</Text></Pressable> : <View style={styles.button} />}
  </View>;
}
const baseStyles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border, paddingHorizontal: 14, gap: 8, minHeight: 52 },
  button: { minHeight: 44, justifyContent: 'center', width: 64 }, save: { alignItems: 'center', backgroundColor: palette.accent, borderRadius: 10 }, saveDisabled: { backgroundColor: palette.elevated },
  saveLabel: { color: palette.accentInk, fontWeight: '600' }, saveLabelDisabled: { color: palette.disabled },
  heading: { ...typography.body, color: palette.ink, fontWeight: '700', flex: 1, textAlign: 'center' },
  action: { ...typography.body, color: palette.accent }, disabled: { opacity: .45 },
});
