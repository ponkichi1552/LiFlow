import { StyleSheet, Text, View } from 'react-native';
import type { ColorValue } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { palette, typography } from './planner-ui';

/** The home greeting keeps its cake; calendar dates use a box with room for the number. */
export function BirthdayCake({ width = 24, height = 22 }: { width?: number; height?: number }) {
  const color: ColorValue = palette.calendarToday;
  return <Svg width={width} height={height} viewBox="0 0 40 32" aria-hidden>
    <Path d="M20 5.5V10" stroke={color} strokeWidth={2} strokeLinecap="round" />
    <Path d="M20 .5C17 3.5 18 5 20 5S23 3.5 20 .5Z" fill={color} />
    <Path d="M4 14C4 8 36 8 36 14V25C36 31 4 31 4 25Z" fill={palette.warningSoft} stroke={color} strokeWidth={1.5} />
    <Path d="M4 14V16C4 20 9 20 9 16M31 16C31 20 36 20 36 16V14" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    <Path d="M9 13C13 16 27 16 31 13M4 23C10 27 30 27 36 23" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round" />
    <Path d="M2 29Q20 34 38 29" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
  </Svg>;
}

export function BirthdayCalendarDate({ day, today, selected }: { day: number; today: boolean; selected: boolean }) {
  return <View pointerEvents="none" style={styles.date}>
    <Svg width={36} height={28} viewBox="0 0 40 34" aria-hidden>
      <Path d="M20 9C13 9 9 7 10 3C11-1 18 3 20 9ZM20 9C27 9 31 7 30 3C29-1 22 3 20 9Z" fill="none" stroke={palette.calendarToday} strokeWidth={1.7} strokeLinejoin="round" />
      <Rect x={5} y={14} width={30} height={18} rx={2} fill={today ? palette.calendarToday : palette.warningSoft} stroke={palette.calendarToday} strokeWidth={1.5} />
      <Rect x={3} y={9} width={34} height={5} rx={1.5} fill={palette.calendarToday} />
      <Path d="M20 9V14" stroke={palette.warningSoft} strokeWidth={2} />
    </Svg>
    <Text style={[styles.number, today && styles.today, selected && styles.selected]}>{day}</Text>
  </View>;
}

const styles = StyleSheet.create({
  date: { width: 36, height: 28, alignItems: 'center' },
  number: { ...typography.calendarDate, fontSize: 16, lineHeight: 20, position: 'absolute', top: 9, color: palette.calendarToday, fontWeight: '600', textAlign: 'center' },
  today: { color: palette.surface, fontWeight: '800' },
  selected: { fontWeight: '800' },
});
