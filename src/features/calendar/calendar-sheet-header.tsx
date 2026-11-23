import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { plannerPressColorsForScheme } from '../../components/planner-theme';
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
export type CalendarSheetForm = { content: ReactNode; onSave?: () => void; disabled: boolean; busy: boolean; entry?: CalendarChoreEntry; hasInput?: boolean };

/** A React boundary keeps render slots separate from the event handlers they receive. */
export function CalendarSheetContent<T>({ render, form }: { render(form: T): ReactNode; form: T }) {
  return render(form);
}

export function CalendarTextAction({ title, label = title, onPress, disabled = false, expanded }: {
  title: string; label?: string; onPress(): void; disabled?: boolean; expanded?: boolean;
}) {
  const pressColors = plannerPressColorsForScheme(useColorScheme());
  return <View style={[baseStyles.button, baseStyles.textActionSlot]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded, disabled }}
      disabled={disabled} onPress={onPress} style={({ pressed }) => [
        baseStyles.textActionSurface, pressed && !disabled && { backgroundColor: pressColors.tinted },
      ]}>
      <Text numberOfLines={1} adjustsFontSizeToFit style={[baseStyles.action, disabled && baseStyles.disabled]}>{title}</Text>
    </Pressable>
  </View>;
}

/** Appointment and chore entry share one sheet and the same close/save positions. */
export function CalendarSheetHeader({ title, onClose, onSave, closeTitle = '閉じる', closeLabel = '予定の編集を閉じる', saveTitle = '保存', saveLabel = '予定を保存', busy = false, saveDisabled = false, closeExpanded }: {
  title: string; onClose(): void; onSave?(): void; closeTitle?: string; closeLabel?: string;
  saveTitle?: string; saveLabel?: string; busy?: boolean; saveDisabled?: boolean; closeExpanded?: boolean;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const pressColors = plannerPressColorsForScheme(useColorScheme());
  const savingDisabled = busy || saveDisabled;
  return <View style={styles.header}>
    <CalendarTextAction title={closeTitle} label={closeLabel} expanded={closeExpanded} disabled={busy} onPress={onClose} />
    <Text numberOfLines={1} adjustsFontSizeToFit style={styles.heading}>{title}</Text>
    {onSave ? <Pressable accessibilityRole="button" accessibilityLabel={saveLabel} accessibilityState={{ disabled: savingDisabled, busy }} disabled={savingDisabled} onPress={onSave}
      style={({ pressed }) => [styles.button, styles.save, savingDisabled && styles.saveDisabled, pressed && !savingDisabled && { backgroundColor: pressColors.primary }]}>
      <Text style={[styles.action, styles.saveLabel, savingDisabled && styles.saveLabelDisabled]}>{busy ? '保存中' : saveTitle}</Text></Pressable> : <View style={styles.button} />}
  </View>;
}
const baseStyles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border, paddingHorizontal: 14, gap: 8, minHeight: 52 },
  button: { minHeight: 44, justifyContent: 'center', width: 64, borderRadius: 10 },
  textActionSlot: { alignItems: 'center' },
  textActionSurface: { minWidth: 44, minHeight: 44, maxWidth: '100%', paddingHorizontal: 6, paddingVertical: 4, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center' },
  save: { alignItems: 'center', backgroundColor: palette.accent }, saveDisabled: { backgroundColor: palette.elevated },
  saveLabel: { color: palette.accentInk, fontWeight: '600' }, saveLabelDisabled: { color: palette.disabled },
  heading: { ...typography.body, color: palette.ink, fontWeight: '700', flex: 1, textAlign: 'center' },
  action: { ...typography.body, color: palette.accent }, disabled: { opacity: .45 },
});
