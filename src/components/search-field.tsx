import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { FormTextInput } from './form-text-input';
import { plannerColorsForScheme } from './planner-theme';

type SearchFieldProps = Pick<TextInputProps, 'accessibilityLabel' | 'placeholder' | 'autoFocus' | 'editable'> & {
  value: string;
  onChangeText(value: string): void;
  style?: StyleProp<ViewStyle>;
};

export function SearchField({ value, onChangeText, style, editable = true, ...props }: SearchFieldProps) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View style={[styles.field, { borderColor: colors.inputBorder, backgroundColor: colors.surface }, style]}>
    <FormTextInput {...props} value={value} onChangeText={onChangeText} editable={editable} autoCapitalize="none"
      autoCorrect={false} clearButtonMode="never" returnKeyType="search" style={[styles.input, { color: colors.ink }]} />
    {value.length > 0 && editable ? <Pressable accessibilityRole="button" accessibilityLabel="検索語を消去"
      onPress={() => onChangeText('')} style={({ pressed }) => [styles.clear, pressed && { backgroundColor: colors.accentSoft }]}>
      <Text accessible={false} allowFontScaling={false} style={[styles.symbol, { color: colors.muted }]}>×</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderWidth: 1, borderRadius: 12 },
  input: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
  clear: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10 },
  symbol: { fontSize: 24, fontWeight: '500' },
});
