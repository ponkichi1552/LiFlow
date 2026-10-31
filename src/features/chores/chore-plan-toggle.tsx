import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { SettingsSwitch } from '../../components/settings-switch';
import { AppButton, palette, typography } from '../../components/planner-ui';

export function ChorePlanToggle({ name, enabled, readOnly = false, save, retryRead }: {
  name: string; enabled: boolean; readOnly?: boolean; save: (enabled: boolean) => Promise<{ refreshed: boolean } | void>;
  retryRead?: () => Promise<boolean>;
}) {
  const [pending, setPending] = useState<boolean | null>(null); const [error, setError] = useState<string | null>(null); const running = useRef(false);
  const [readPending, setReadPending] = useState(false);
  useEffect(() => { if (!running.current && pending === enabled) { setPending(null); setReadPending(false); setError(null); } }, [enabled, pending]);
  const change = async (value: boolean) => {
    if (running.current || readOnly) return;
    running.current = true; setPending(value); setError(null); let retain = false;
    try { const result = await save(value); if (result?.refreshed === false) { retain = true; setReadPending(true); setError('保存済みです。表示を読み直してください。'); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : '予定の設定を保存できませんでした。'); }
    finally { running.current = false; if (!retain) setPending(null); }
  };
  return <View style={{ maxWidth: 180, gap: 4 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <Text style={[typography.caption, { color: palette.muted }]}>予定に追加</Text><SettingsSwitch value={pending ?? enabled} disabled={readOnly || pending !== null}
      accessibilityLabel={`${name}を予定に追加`} accessibilityHint={readOnly ? '有効・無効はグループの管理者が変更できます' : undefined} onValueChange={value => void change(value)} />
  </View>{error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
    {readPending && retryRead ? <AppButton title="表示を再読込" variant="quiet" compact onPress={() => {
      if (running.current) return; running.current = true;
      void retryRead().then(ok => { if (ok) { setPending(null); setReadPending(false); setError(null); } })
        .catch(() => setError('表示を読み込めませんでした。保存済みの設定は保持しています。')).finally(() => { running.current = false; });
    }} /> : null}</View>;
}
