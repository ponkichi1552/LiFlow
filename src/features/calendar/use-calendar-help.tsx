import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { createCalendarHelpStore } from './help-store';

const store = createCalendarHelpStore(Storage);

export function useCalendarHelp(allowed: boolean, binding = store) {
  const [open, setOpen] = useState(false);
  const focused = useRef(false); const showing = useRef(false);
  const introduction = useRef<ReturnType<typeof store.claimIntroduction>>(null);
  const close = useCallback(() => {
    showing.current = false; setOpen(false); introduction.current?.release(); introduction.current = null;
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (allowed) {
      introduction.current = binding.claimIntroduction();
      if (introduction.current) { showing.current = true; setOpen(true); }
    }
    return () => { focused.current = false; close(); };
  }, [allowed, binding, close]));
  return { open, close,
    show() { if (focused.current && allowed) { showing.current = true; setOpen(true); } },
    onShow() {
      if (!focused.current || !showing.current) return;
      if (introduction.current) { introduction.current.shown(); introduction.current = null; }
      else binding.shown();
    },
  };
}
