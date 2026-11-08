import { useContext, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Chevron } from '../../../components/chevron';
import { AccordionSection } from '../../../components/accordion-section';
import { palette, typography } from '../../../components/planner-ui';
import { V2SettingsDraftCache } from './settings-draft-cache';

/** Closing the outer section must not hide invalid or failed inner drafts. */
export function V2AdvancedSettings({ choreId, children, needsReview = false, onOpen }: { choreId: string; children?: ReactNode; needsReview?: boolean; onOpen?(): void }) {
  const cache = useContext(V2SettingsDraftCache); const closing = useRef(false);
  const [open, setOpen] = useState(false); const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (!open) { setOpen(true); return; }
    if (closing.current) return; closing.current = true; setError(null);
    try {
      for (const key of [`configuration:${choreId}`, `details:${choreId}`, `rights:${choreId}`]) if (cache?.has(key) && !await cache.get(key)!.flush()) {
        setError('入力内容を確認してください。'); return;
      }
      setOpen(false);
    } catch { setError('保存できませんでした。入力は保持しています。'); }
    finally { closing.current = false; }
  };
  if (onOpen) return <Pressable accessibilityRole="button" accessibilityLabel="詳細設定を開く" onPress={onOpen}
    style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
    <Text style={[typography.label, { color: palette.ink }]}>詳細設定</Text><Chevron />
  </Pressable>;
  return <View><AccordionSection plain keepMounted title="詳細設定" expanded={open || needsReview} onToggle={() => void toggle()}>{children}</AccordionSection>
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}</View>;
}
