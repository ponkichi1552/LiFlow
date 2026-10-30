import { Platform, StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor } from '@/constants/theme';
import { typography } from '@/components/planner-typography';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'title' | 'small' | 'smallBold' | 'subtitle' | 'link' | 'linkPrimary' | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  const color = type === 'linkPrimary' ? styles.linkPrimary.color : theme[themeColor ?? 'text'];
  return <Text style={[styles[type], { color }, style]} {...rest} />;
}

const styles = StyleSheet.create({
  small: {
    ...typography.caption,
    fontWeight: 500,
  },
  smallBold: {
    ...typography.caption,
    fontWeight: 700,
  },
  default: {
    ...typography.body,
    fontWeight: 500,
  },
  title: {
    ...typography.title,
    fontWeight: 600,
  },
  subtitle: {
    ...typography.section,
    fontWeight: 600,
  },
  link: {
    ...typography.label,
  },
  linkPrimary: {
    ...typography.label,
    color: '#3c87f7',
  },
  code: {
    fontFamily: Fonts.mono,
    fontWeight: Platform.select({ android: 700 }) ?? 500,
    ...typography.small,
  },
});
