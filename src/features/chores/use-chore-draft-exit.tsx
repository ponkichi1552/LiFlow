import { useRef, useState, type RefObject } from 'react';
import { Alert, Platform } from 'react-native';
import { usePreventRemove } from 'expo-router';

export function useChoreDraftExit(dirty: boolean, saving: boolean, pending: RefObject<boolean>) {
  const [leaving, setLeaving] = useState(false);
  const confirming = useRef(false);
  const disablePrevention = usePreventRemove(!leaving && (dirty || saving), ({ repeat }) => {
    if (pending.current || confirming.current) return;
    const leave = () => {
      confirming.current = false;
      setLeaving(true);
      repeat();
    };
    if (!dirty) { leave(); return; }
    const title = '家事の入力を破棄しますか？';
    if (Platform.OS === 'web') {
      if (window.confirm(title)) leave();
      return;
    }
    confirming.current = true;
    Alert.alert(title, undefined, [
      { text: '入力を続ける', style: 'cancel', onPress: () => { confirming.current = false; } },
      { text: '破棄', style: 'destructive', onPress: leave },
    ]);
  });
  return () => {
    setLeaving(true);
    disablePrevention();
  };
}
