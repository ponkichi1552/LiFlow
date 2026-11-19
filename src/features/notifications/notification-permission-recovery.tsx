import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Text, View, useColorScheme } from 'react-native';
import { SettingsAction } from '../../components/settings-controls';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { expoLocalNotificationGateway } from '../../platform/notifications/expo-local-notification-gateway';
import { openDeviceNotificationSettings } from '../../platform/notifications/notification-settings';

const readDevicePermission = () => expoLocalNotificationGateway.hasPermission();

/** The app preference can stay on while the OS blocks delivery. */
export function useDeviceNotificationPermission(scope: unknown, enabled: boolean, checkPermission = readDevicePermission) {
  const [status, setStatus] = useState<{ scope: unknown; allowed: boolean | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let latestCheck = 0;
    const check = () => {
      const id = ++latestCheck;
      void Promise.resolve().then(checkPermission).then(allowed => {
        if (live && id === latestCheck) setStatus({ scope, allowed });
      }).catch(() => {
        if (live && id === latestCheck) setStatus({ scope, allowed: null });
      });
    };
    check();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    return () => { live = false; subscription.remove(); };
  }, [scope, enabled, checkPermission]);
  return enabled && status?.scope === scope ? status?.allowed ?? null : null;
}

/** Finish the user's denied enable request only after they return with OS permission. */
export function NotificationPermissionRecovery({ onGranted, disabled = false, scope, checkPermission = readDevicePermission, openSettings = openDeviceNotificationSettings }: {
  onGranted?(): void | Promise<void>; disabled?: boolean; scope?: unknown; checkPermission?: () => Promise<boolean>;
  openSettings?: () => Promise<void>;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const [error, setError] = useState<string | null>(null); const [opening, setOpening] = useState(false);
  const latest = useRef({ onGranted, checkPermission, disabled, scope });
  useLayoutEffect(() => { latest.current = { onGranted, checkPermission, disabled, scope }; }, [onGranted, checkPermission, disabled, scope]);
  const alive = useRef(true); const waiting = useRef(false); const openingLock = useRef(false); const attempt = useRef(0);
  useEffect(() => {
    alive.current = true; waiting.current = false;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' || !waiting.current || latest.current.disabled || !latest.current.onGranted) return;
      const capturedScope = latest.current.scope, capturedAttempt = attempt.current;
      waiting.current = false;
      void latest.current.checkPermission().then(async granted => {
        if (!granted || !alive.current || attempt.current !== capturedAttempt || latest.current.disabled || latest.current.scope !== capturedScope) return;
        await latest.current.onGranted?.();
      }).catch(() => { if (alive.current && attempt.current === capturedAttempt) setError('通知の許可を確認できませんでした。もう一度お試しください。'); });
    });
    return () => { alive.current = false; waiting.current = false; subscription.remove(); };
  }, [scope]);
  return <View style={{ gap: 6, alignItems: 'flex-start' }}>
    <SettingsAction title="端末の設定を開く" placement="page" compact disabled={disabled || opening} onPress={() => {
      if (openingLock.current || latest.current.disabled) return;
      attempt.current++;
      openingLock.current = true; waiting.current = Boolean(latest.current.onGranted); setOpening(true); setError(null);
      void Promise.resolve().then(openSettings).catch(() => { waiting.current = false; if (alive.current) setError('端末の設定を開けませんでした。もう一度お試しください。'); })
        .finally(() => { openingLock.current = false; if (alive.current) setOpening(false); });
    }} />
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning }}>{error}</Text> : null}
  </View>;
}
