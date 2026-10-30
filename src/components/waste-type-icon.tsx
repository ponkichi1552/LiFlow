import { SymbolView } from 'expo-symbols';
import type { SymbolViewProps } from 'expo-symbols';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { ColorValue, StyleProp, TextStyle, ViewStyle } from 'react-native';
import Svg, { Ellipse, G, Line, Path } from 'react-native-svg';
import { calendarWasteLabel, wasteTypeColor, wasteTypeIcon } from '../features/waste/type-appearance';
import type { WasteIconKind } from '../features/waste/type-appearance';
import { typography } from './planner-typography';

const symbols: Partial<Record<WasteIconKind, SymbolViewProps['name']>> = {
  fire: { ios: 'flame', android: 'local_fire_department' }, paper: { ios: 'doc.text', android: 'description' },
  box: { ios: 'shippingbox', android: 'inventory_2' }, recycle: { ios: 'arrow.3.trianglepath', android: 'recycling' },
  battery: { ios: 'battery.100', android: 'battery_full' }, appliance: { ios: 'powerplug', android: 'electrical_services' },
  bulky: { ios: 'sofa', android: 'chair' }, plant: { ios: 'leaf', android: 'eco' },
  food: { ios: 'carrot', android: 'nutrition' }, hazard: { ios: 'exclamationmark.triangle', android: 'warning' },
  oil: { ios: 'drop', android: 'water_drop' }, trash: { ios: 'trash', android: 'delete_outline' },
};

function Bottle() {
  return <><Path d="M9 2h6v3h-1v3.2c0 1.4 4 2.4 4 5V20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6.8c0-2.6 4-3.6 4-5V5H9V2Z" /><Line x1="10" y1="16" x2="14" y2="16" /></>;
}
function Can() {
  return <><Ellipse cx="12" cy="4.5" rx="6" ry="2.5" /><Path d="M6 4.5v15c0 3.3 12 3.3 12 0v-15M6 18.5c0 3.3 12 3.3 12 0" /><Line x1="10" y1="4.5" x2="14" y2="4.5" /></>;
}

/** Shape, label and color carry the same identity on both mobile platforms. */
export function WasteTypeIcon({ label, size = 20, color: supplied }: { label: string; size?: number; color?: ColorValue }) {
  const scheme = useColorScheme();
  const color = supplied ?? wasteTypeColor(label, scheme === 'dark' ? 'dark' : 'light');
  const kind = wasteTypeIcon(label);
  if (kind !== 'bottle' && kind !== 'petBottle' && kind !== 'can' && kind !== 'bottleCan') return <SymbolView
    name={symbols[kind] ?? symbols.trash!} size={size} tintColor={color} weight="regular" aria-hidden style={{ width: size, height: size }} />;
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === 'bottle' ? <Bottle /> : kind === 'can' ? <Can /> : kind === 'bottleCan' ? <>
      <G transform="translate(-1 0) scale(.72 1)"><Bottle /></G><G transform="translate(10 7) scale(.57 .66)"><Can /></G>
    </> : <>
      <Path d="M9 2h6v3l-1 1v2c0 1 4 2 4 4v7c0 1.5-1 3-3 3h-1l-2-1-2 1H9c-2 0-3-1.5-3-3v-7c0-2 4-3 4-4V6L9 5V2Z" />
      <Path d="M8.5 12h7M8 15h8M8.5 18h7M10 5h4" />
    </>}
  </Svg>;
}

export function WasteTypeLabel({ label, compact = true, size = 16, style, textStyle }: {
  label: string; compact?: boolean; size?: number; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>;
}) {
  const scheme = useColorScheme();
  const color = wasteTypeColor(label, scheme === 'dark' ? 'dark' : 'light');
  return <View style={[styles.label, style]}><WasteTypeIcon label={label} size={size} color={color} />
    <Text numberOfLines={compact ? 2 : undefined} style={[styles.text, { color }, textStyle]}>{compact ? calendarWasteLabel(label) : label}</Text>
  </View>;
}
const styles = StyleSheet.create({
  label: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '100%' },
  text: { ...typography.calendarLabel, flexShrink: 1, fontWeight: '500' },
});
