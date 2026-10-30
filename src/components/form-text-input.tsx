import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import type { TextInputProps } from 'react-native';
import { typography } from './planner-typography';
import { palette } from './planner-colors';

/** Native editable text uses font metrics rather than paragraph line spacing. */
export function FormTextInput({ style, multiline = false, ...props }: TextInputProps) {
  // In RN, changing defaultValue also changes the native `text` prop. Keep an
  // uncontrolled field's initial value stable while native input is in flight.
  const [initialDefaultValue] = useState(props.defaultValue);
  return <TextInput {...props} defaultValue={initialDefaultValue} multiline={multiline} underlineColorAndroid="transparent"
    placeholderTextColor={props.placeholderTextColor ?? palette.muted} selectionColor={props.selectionColor ?? palette.accent}
    style={[styles.base, style, { lineHeight: undefined, includeFontPadding: false, textAlignVertical: multiline ? 'top' : 'center' }]} />;
}
const styles = StyleSheet.create({ base: { fontSize: typography.body.fontSize, minHeight: 48, paddingVertical: 10, color: palette.ink } });
