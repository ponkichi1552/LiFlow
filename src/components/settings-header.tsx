import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { BackButton, palette, typography } from './planner-ui';
import { plannerColorsForScheme } from './planner-theme';
import { useAppAppearance } from '../hooks/use-app-appearance';

export function SettingsHeader({ title, onBack = () => router.back(), appearance = false, backDisabled = false }: { title: string; onBack?: () => void; appearance?: boolean; backDisabled?: boolean }) {
  return <View style={styles.header}><BackButton onPress={onBack} disabled={backDisabled} />
    <View pointerEvents="none" style={styles.titleSlot}><Text style={styles.headerTitle} numberOfLines={1}>{title}</Text></View>
    {appearance ? <AppearanceButton /> : <View style={{ width: 44 }} />}</View>;
}
function AppearanceButton() {
  const scheme = useColorScheme(); const appearance = useAppAppearance(); const [error, setError] = useState<string | null>(null);
  const colors = plannerColorsForScheme(scheme);
  const dark = scheme === 'dark';
  return <View><Pressable accessibilityRole="button" accessibilityLabel={dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
    onPress={() => { try { appearance.set(dark ? 'light' : 'dark'); setError(null); } catch { setError('表示設定を保存できませんでした。'); } }}
    style={({ pressed }) => [styles.appearanceButton, { borderColor: colors.border, backgroundColor: colors.surface }, pressed && styles.pressed]}>
    <Svg width={23} height={23} viewBox="0 0 24 24" fill="none" stroke={palette.accent} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {dark ? <><Circle cx={12} cy={12} r={4} /><Path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4L19 5" /></> : <Path d="M20.5 14.4A8.8 8.8 0 0 1 9.6 3.5a8.8 8.8 0 1 0 10.9 10.9Z" />}
    </Svg>
  </Pressable>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>;
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  titleSlot: { position: 'absolute', left: 83, right: 83, top: 0, bottom: 0, justifyContent: 'center' },
  headerTitle: { ...typography.body, color: palette.ink, fontWeight: '700', textAlign: 'center' },
  appearanceButton: { width: 44, minHeight: 44, borderWidth: 1, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  pressed: { opacity: 0.7 }, error: { ...typography.caption, color: palette.warning },
});
