import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Text, View, useColorScheme } from 'react-native';
import { SettingsAction } from '../../components/settings-controls';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { expoLocalNotificationGateway } from '../../platform/notifications/expo-local-notification-gateway';
import { openDeviceNotificationSettings } from '../../platform/notifications/notification-settings';

/** Finish the user's denied enable request only after they return with OS permission. */
export function NotificationPermissionRecovery({ onGranted, disabled = false, scope, checkPermission = () => expoLocalNotificationGateway.hasPermission() }: {
  onGranted(): void | Promise<void>; disabled?: boolean; scope?: unknown; checkPermission?: () => Promise<boolean>;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const [error, setError] = useState<string | null>(null); const [opening, setOpening] = useState(false);
  const latest = useRef({ onGranted, checkPermission, disabled, scope });
  useLayoutEffect(() => { latest.current = { onGranted, checkPermission, disabled, scope }; }, [onGranted, checkPermission, disabled, scope]);
  const alive = useRef(true); const waiting = useRef(false); const checking = useRef(false); const openingLock = useRef(false);
  useEffect(() => {
    alive.current = true; waiting.current = false;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' || !waiting.current || checking.current || latest.current.disabled) return;
      const capturedScope = latest.current.scope;
      checking.current = true;
      void latest.current.checkPermission().then(async granted => {
        if (!granted || !alive.current || !waiting.current || latest.current.disabled || latest.current.scope !== capturedScope) return;
        waiting.current = false; await latest.current.onGranted();
      }).catch(() => { if (alive.current) setError('通知の許可を確認できませんでした。もう一度お試しください。'); })
        .finally(() => { checking.current = false; });
    });
    return () => { alive.current = false; waiting.current = false; subscription.remove(); };
  }, [scope]);
  return <View style={{ gap: 6, alignItems: 'flex-start' }}>
    <SettingsAction title="端末の設定を開く" placement="page" compact disabled={disabled || opening} onPress={() => {
      if (openingLock.current || latest.current.disabled) return;
      openingLock.current = true; waiting.current = true; setOpening(true); setError(null);
      void Promise.resolve().then(openDeviceNotificationSettings).catch(() => { waiting.current = false; if (alive.current) setError('端末の設定を開けませんでした。もう一度お試しください。'); })
        .finally(() => { openingLock.current = false; if (alive.current) setOpening(false); });
    }} />
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning }}>{error}</Text> : null}
  </View>;
}
