import { useFocusEffect } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { SettingsAction } from '../../components/settings-controls';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { readApplianceManual } from '../../platform/storage/appliance-manuals';
import { showManualPdf } from '../../platform/appliance-care/manual-viewer';
import { openSavedManual } from './open-saved-manual';

export function ApplianceManualAction({ database, digest, label, accessKey, disabled = false }: {
  database: SQLiteDatabase; digest: string; label: string; accessKey: string; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const [status, setStatus] = useState<{ database: SQLiteDatabase; digest: string; accessKey: string; busy: boolean; error: string | null } | null>(null);
  const visibleStatus = status?.database === database && status.digest === digest && status.accessKey === accessKey ? status : null;
  const busy = visibleStatus?.busy ?? false; const error = visibleStatus?.error;
  const current = useRef<{ database: SQLiteDatabase; digest: string; accessKey: string } | null>(null);
  const allowed = useRef(false);
  const focused = useRef(false);
  const pending = useRef<symbol | null>(null);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    setStatus(before => before?.busy ? { ...before, busy: false } : before);
    return () => { focused.current = false; pending.current = null; };
  }, []));
  useLayoutEffect(() => { current.current = { database, digest, accessKey }; pending.current = null; return () => { current.current = null; pending.current = null; }; }, [database, digest, accessKey]);
  useLayoutEffect(() => { allowed.current = !disabled; }, [disabled]);
  const open = async () => {
    const capture = current.current;
    if (!capture || !allowed.current || !focused.current || pending.current) return;
    const token = Symbol(); pending.current = token; setStatus({ ...capture, busy: true, error: null });
    const isCurrent = () => pending.current === token && current.current?.database === capture.database
      && current.current.digest === capture.digest && current.current.accessKey === capture.accessKey && allowed.current && focused.current;
    try {
      await openSavedManual({ digest: capture.digest, read: key => readApplianceManual(capture.database, key), isCurrent,
        present: (bytes, key, guard) => showManualPdf(bytes, key, `${label}の説明書`, guard) });
    } catch (cause) { if (isCurrent()) setStatus({ ...capture, busy: false, error: cause instanceof Error ? cause.message : '説明書を開けませんでした。もう一度お試しください。' }); }
    finally { if (pending.current === token) { pending.current = null; setStatus(before => before && { ...before, busy: false }); } }
  };
  return <View style={{ gap: 6, alignItems: 'flex-start' }}>
    <SettingsAction title="説明書を開く" intent="auxiliary" placement="page" compact disabled={disabled || busy} onPress={() => void open()} />
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning }}>{error}</Text> : null}
  </View>;
}
