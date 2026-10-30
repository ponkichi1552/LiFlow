import type { PropsWithChildren, ReactNode } from 'react';
import { useContext } from 'react';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { typography } from './planner-typography';
import { WorkspaceContext } from '../contexts/workspace-context';
import { PlannerIssuesContext } from '../contexts/planner-issues-context';

import { palette } from './planner-colors';
import { Chevron } from './chevron';

export { typography } from './planner-typography';
export { palette } from './planner-colors';


export function Page({ children, contentStyle, keyboardAware = false, footer, footerHasTabBar = false, compactWorkspace = false, floatingFooter = false }: PropsWithChildren<{ contentStyle?: object; keyboardAware?: boolean; footer?: ReactNode; footerHasTabBar?: boolean; compactWorkspace?: boolean; floatingFooter?: boolean }>) {
  const insets = useSafeAreaInsets();
  const workspace = useContext(WorkspaceContext);
  const issues = useContext(PlannerIssuesContext);
  const issueCount = workspace?.active?.groupId === issues?.groupId ? issues?.issueCount ?? 0 : 0;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets={keyboardAware}
        keyboardDismissMode={keyboardAware ? 'on-drag' : 'none'} contentContainerStyle={[styles.page, contentStyle]}>
        {workspace?.active && !compactWorkspace ? <Pressable accessibilityRole="button" accessibilityLabel="共有グループを切り替える" onPress={() => router.push('/sharing')}
          style={styles.workspaceBanner}><Text style={styles.workspaceName}>共有 · {workspace.groups.find((group) => group.groupId === workspace.active!.groupId)?.displayName ?? '共有グループ'}</Text><ActionLabel label="切り替え" style={styles.workspaceSwitch} color={palette.muted} /></Pressable> : null}
        {workspace?.error ? <Text accessibilityRole="alert" style={styles.workspaceError}>{workspace.error}</Text> : null}
        {issueCount > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="共有データを確認する"
          onPress={() => router.push('/sharing')} style={styles.planningNotice}>
          <Text style={styles.planningNoticeText}>共有データに確認が必要な項目があります（{issueCount}件）。</Text>
          <ActionLabel label="内容を確認" style={styles.planningNoticeLink} color={palette.gold} />
        </Pressable> : null}
        {children}
      </ScrollView>
      {footer ? <View pointerEvents="box-none" style={floatingFooter ? { position: 'absolute', left: 0, right: 0, bottom: footerHasTabBar ? 0 : insets.bottom } : [styles.footer, { paddingBottom: footerHasTabBar ? 8 : Math.max(insets.bottom, 8) }]}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function ScreenHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return (
    <View style={styles.heading}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: object }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionHeading({ title, trailing, level = 'section' }: { title: string; trailing?: ReactNode; level?: 'section' | 'subsection' }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={[styles.sectionTitle, level === 'subsection' && styles.subsectionTitle]}>{title}</Text>
      {trailing}
    </View>
  );
}

export function BackButton({
  onPress,
  accessibilityLabel = '前の画面に戻る',
  disabled = false,
}: {
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed, disabled && styles.buttonDisabled]}>
      <Chevron direction="left" />
      <Text style={styles.backText}>戻る</Text>
    </Pressable>
  );
}

/** Link text uses the same arrow geometry as Back, disclosures and calendar navigation. */
export function ActionLabel({ label, style, color = palette.accent }: { label: string; style?: StyleProp<TextStyle>; color?: string }) {
  return <View style={styles.actionLabel}><Text style={[style, styles.actionLabelText, { color }]}>{label}</Text><Chevron color={color} /></View>;
}

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  compact = false,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  disabled?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        styles[`button_${variant}`],
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}>
      {title === '‹' || title === '›' ? <Chevron direction={title === '‹' ? 'left' : 'right'} />
        : <Text style={[styles.buttonText, styles[`buttonText_${variant}`], compact && styles.buttonTextCompact]}>{title}</Text>}
    </Pressable>
  );
}

export function ChoiceChip({
  label,
  selected,
  onPress,
  disabled = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.buttonPressed]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const label = status === 'overdue'
    ? '超過'
    : status === 'inWindow'
      ? '実施期間中'
      : status === 'initialPending'
        ? '初回の予定'
        : 'これから';
  const isOverdue = status === 'overdue';
  return (
    <View style={[styles.badge, isOverdue && styles.badgeWarning]}>
      <Text style={[styles.badgeText, isOverdue && styles.badgeTextWarning]}>{label}</Text>
    </View>
  );
}

export function MutedText({ children }: PropsWithChildren) {
  return <Text style={styles.mutedText}>{children}</Text>;
}

const styles = StyleSheet.create({
  actionLabel: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1 },
  actionLabelText: { flexShrink: 1 },
  workspaceBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: palette.accentSoft },
  workspaceName: { ...typography.label, color: palette.ink, fontWeight: '700', flex: 1 },
  workspaceSwitch: { ...typography.caption, color: palette.muted },
  workspaceError: { ...typography.caption, color: palette.warning },
  planningNotice: { padding: 12, gap: 4, borderRadius: 12, backgroundColor: palette.goldSoft, minHeight: 48 },
  planningNoticeText: { ...typography.label, color: palette.ink },
  planningNoticeLink: { ...typography.label, color: palette.gold, fontWeight: '700' },
  safeArea: { flex: 1, backgroundColor: palette.background },
  footer: { paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, backgroundColor: palette.surface },
  page: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36, gap: 12 },
  heading: { gap: 5, marginBottom: 2 },
  eyebrow: { ...typography.caption, color: palette.accent, fontWeight: '700', letterSpacing: 1.4 },
  title: { ...typography.title, color: palette.ink, fontWeight: '700' },
  description: { ...typography.body, color: palette.muted },
  card: { backgroundColor: palette.surface, borderRadius: 16, borderWidth: 1, borderColor: palette.border, padding: 14, gap: 10 },
  sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, rowGap: 4, marginTop: 2 },
  sectionTitle: { ...typography.section, color: palette.ink, fontWeight: '700', flexShrink: 1 },
  subsectionTitle: { ...typography.control },
  backButton: { alignSelf: 'flex-start', minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingRight: 16, gap: 6 },
  backIcon: { width: 20, height: 24, alignItems: 'center', justifyContent: 'center' },
  backChevron: { width: 11, height: 11, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: palette.accent, transform: [{ rotate: '45deg' }] },
  backText: { ...typography.control, color: palette.accent, fontWeight: '700' },
  button: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 10 },
  buttonCompact: { minHeight: 44, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 12 },
  button_primary: { backgroundColor: palette.accent },
  button_secondary: { backgroundColor: palette.accentSoft },
  button_quiet: { backgroundColor: 'transparent' },
  button_danger: { backgroundColor: palette.warningSoft },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { ...typography.control, fontWeight: '700', textAlign: 'center' },
  buttonTextCompact: { ...typography.label },
  buttonText_primary: { color: palette.accentInk },
  buttonText_secondary: { color: palette.accent },
  buttonText_quiet: { color: palette.muted },
  buttonText_danger: { color: palette.warning },
  chip: { minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  chipSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  chipText: { ...typography.label, color: palette.muted, fontWeight: '600', textAlign: 'center' },
  chipTextSelected: { color: palette.accent, fontWeight: '700' },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: palette.accentSoft },
  badgeWarning: { backgroundColor: palette.warningSoft },
  badgeText: { ...typography.caption, color: palette.accent, fontWeight: '700' },
  badgeTextWarning: { color: palette.warning },
  mutedText: { ...typography.caption, color: palette.muted },
});
