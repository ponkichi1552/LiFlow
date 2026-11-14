import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { SettingsAction } from '../../components/settings-controls';
import { WorkspaceContext } from '../../contexts/workspace-context';
import { subscribeToGoogleAccountChanges } from '../google-sync/account-change-events';
import type { SQLiteDatabase } from 'expo-sqlite';

type AccountActionProps = { prepare(): Promise<boolean>; database: SQLiteDatabase;
  disabled?: boolean; acquire?(): boolean; release?(): void; onChanged?(): Promise<void> };

/** Explicit account selection never joins or leaves a group. */
export function GoogleAccountSwitch(props: AccountActionProps) { return <AccountSessionAction {...props} action="switch" />; }
export function AccountSignOut(props: AccountActionProps) { return <AccountSessionAction {...props} action="logout" />; }

/** Both account actions use the same settings lock and finish local writes first. */
function AccountSessionAction({ prepare, database, disabled, acquire, release, onChanged, action }: AccountActionProps & { action: 'switch' | 'logout' }) {
  const workspace = useContext(WorkspaceContext);
  const owner = useRef({ userId: workspace?.userId, active: workspace?.active, database }); const working = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [nativeSession, setNativeSession] = useState(false);
  useLayoutEffect(() => { owner.current = { userId: workspace?.userId, active: workspace?.active, database }; }, [workspace?.userId, workspace?.active, database]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (workspace?.userId || disabled || busy) return;
    let active = true;
    const read = () => { void import('../../platform/google-tasks/google-sign-in-gateway').then(module => module.getCurrentGoogleSubject())
      .then(subject => { if (active) setNativeSession(Boolean(subject)); }).catch(() => { if (active) setNativeSession(false); }); };
    read();
    const stop = subscribeToGoogleAccountChanges(database, read);
    return () => { active = false; stop(); };
  }, [action, workspace?.userId, database, disabled, busy]);
  if (!workspace?.userId && !nativeSession) return null;
  const perform = async () => {
    if (working.current || disabled || acquire && !acquire()) return; working.current = true; setBusy(true); setError(null);
    const expected = workspace?.userId; const expectedActive = workspace?.active;
    const current = () => alive.current && owner.current.userId === expected && owner.current.active === expectedActive && owner.current.database === database;
    try {
      if (!await prepare()) { if (alive.current) setError('設定の保存を確認してから、もう一度お試しください。'); return; }
      if (!current()) throw new Error('Account changed before draining local work');
      await expectedActive?.drain();
      if (action === 'logout') {
        const { signOutGoogleAccount } = await import('../google-sync/account-switch');
        if (!current()) throw new Error('Account changed before logout');
        await signOutGoogleAccount(database);
      } else {
        const { changeGoogleAccount } = await import('../google-sync/account-switch');
        if (!current()) throw new Error('Account changed before selection');
        await changeGoogleAccount(database);
      }
      await workspace?.refreshSharing();
      if (alive.current) await onChanged?.();
    } catch { if (alive.current) setError(action === 'logout' ? 'ログアウトできませんでした。もう一度お試しください。' : 'アカウントの変更を完了できませんでした。もう一度お試しください。'); }
    finally { working.current = false; release?.(); if (alive.current) setBusy(false); }
  };
  return <>
    <SettingsAction title={action === 'logout' ? 'ログアウト' : 'Googleアカウントを変更'} intent={action === 'logout' ? 'destructive' : 'normal'} placement="page" disabled={busy || disabled} onPress={() => { void perform(); }} />
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
  </>;
}
