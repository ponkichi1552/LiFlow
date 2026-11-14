import { Linking, Platform } from 'react-native';

export async function openDeviceNotificationSettings(): Promise<void> {
  if (Platform.OS === 'ios') {
    // UIApplication.openNotificationSettingsURLString (iOS 16+, below this SDK's minimum).
    try { await Linking.openURL('app-settings:notifications'); return; }
    catch { /* Older/custom system handlers can still open the app's settings. */ }
  }
  await Linking.openSettings();
}
