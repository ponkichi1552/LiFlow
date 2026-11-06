import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { WorkspaceContext } from '../../contexts/workspace-context';
import type { SQLiteDatabase } from 'expo-sqlite';

/** Explicit account selection belongs to personal account settings; it never joins or leaves a group. */
export function GoogleAccountSwitch({ prepare, database, disabled, acquire, release, onChanged }: { prepare(): Promise<boolean>; database: SQLiteDatabase;
  disabled?: boolean; acquire?(): boolean; release?(): void; onChanged?(): Promise<void> }) {
  const workspace = useContext(WorkspaceContext);
  const owner = useRef(workspace?.userId); const working = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { owner.current = workspace?.userId; }, [workspace?.userId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!workspace?.userId) return null;
  const select = async () => {
    if (working.current || disabled || acquire && !acquire()) return; working.current = true; setBusy(true); setError(null);
    const expected = workspace.userId;
    try {
      if (!await prepare()) { if (alive.current) setError('設定の保存を確認してから、もう一度お試しください。'); return; }
      if (!alive.current || owner.current !== expected) throw new Error('Account changed before draining local work');
      await workspace.active?.drain();
      const { changeGoogleAccount } = await import('../google-sync/account-switch');
      if (!alive.current || owner.current !== expected) throw new Error('Account changed before selection');
      await changeGoogleAccount(database); await workspace.refreshSharing();
      if (alive.current) await onChanged?.();
    } catch { if (alive.current) setError('アカウントの変更を完了できませんでした。もう一度お試しください。'); }
    finally { working.current = false; release?.(); if (alive.current) setBusy(false); }
  };
  return <>
    <AppButton title="Googleアカウントを変更" variant="quiet" compact disabled={busy || disabled} onPress={() => { void select(); }} />
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
  </>;
}
