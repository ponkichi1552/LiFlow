import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { WorkspaceContext } from '../../contexts/workspace-context';
import type { SQLiteDatabase } from 'expo-sqlite';

type AccountActionProps = { prepare(): Promise<boolean>; database: SQLiteDatabase;
  disabled?: boolean; acquire?(): boolean; release?(): void; onChanged?(): Promise<void> };

/** Explicit account selection never joins or leaves a group. */
export function GoogleAccountSwitch(props: AccountActionProps) { return <AccountSessionAction {...props} action="switch" />; }
export function AccountSignOut(props: AccountActionProps) { return <AccountSessionAction {...props} action="logout" />; }

/** Both account actions use the same settings lock and finish local writes first. */
function AccountSessionAction({ prepare, database, disabled, acquire, release, onChanged, action }: AccountActionProps & { action: 'switch' | 'logout' }) {
  const workspace = useContext(WorkspaceContext);
  const owner = useRef({ userId: workspace?.userId, active: workspace?.active }); const working = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { owner.current = { userId: workspace?.userId, active: workspace?.active }; }, [workspace?.userId, workspace?.active]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!workspace?.userId) return null;
  const perform = async () => {
    if (working.current || disabled || acquire && !acquire()) return; working.current = true; setBusy(true); setError(null);
    const expected = workspace.userId; const expectedActive = workspace.active;
    const current = () => alive.current && owner.current.userId === expected && owner.current.active === expectedActive;
    try {
      if (!await prepare()) { if (alive.current) setError('設定の保存を確認してから、もう一度お試しください。'); return; }
      if (!current()) throw new Error('Account changed before draining local work');
      await expectedActive?.drain();
      if (action === 'logout') {
        const { signOutSharing } = await import('../../platform/sharing/auth');
        if (!current()) throw new Error('Account changed before logout');
        await signOutSharing();
      } else {
        const { changeGoogleAccount } = await import('../google-sync/account-switch');
        if (!current()) throw new Error('Account changed before selection');
        await changeGoogleAccount(database);
      }
      await workspace.refreshSharing();
      if (alive.current) await onChanged?.();
    } catch { if (alive.current) setError(action === 'logout' ? 'ログアウトできませんでした。もう一度お試しください。' : 'アカウントの変更を完了できませんでした。もう一度お試しください。'); }
    finally { working.current = false; release?.(); if (alive.current) setBusy(false); }
  };
  return <>
    <AppButton title={action === 'logout' ? 'ログアウト' : 'Googleアカウントを変更'} variant={action === 'logout' ? 'dangerText' : 'quiet'} compact disabled={busy || disabled} onPress={() => { void perform(); }} />
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
  </>;
}
