module.exports = ({ config }) => {
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim() || null;
  const appleSharingEnabled = process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED === 'true';
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
    throw new Error('APPLE_TEAM_ID must be a 10-character Apple development team ID.');
  }
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim()
    || process.env.GOOGLE_WEB_CLIENT_ID?.trim() || null;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim()
    || process.env.GOOGLE_IOS_CLIENT_ID?.trim() || null;
  const iosClientIdSuffix = '.apps.googleusercontent.com';
  if (iosClientId && !iosClientId.endsWith(iosClientIdSuffix)) {
    throw new Error('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID must be a Google OAuth client ID.');
  }
  const iosUrlScheme = process.env.GOOGLE_IOS_REVERSED_CLIENT_ID?.trim()
    || (iosClientId ? `com.googleusercontent.apps.${iosClientId.slice(0, -iosClientIdSuffix.length)}` : null);
  const hasNativeGoogleConfiguration = Boolean(webClientId && iosClientId && iosUrlScheme);
  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = typeof plugin === 'string' ? plugin : plugin[0];
    return name !== 'react-native-nitro-google-signin' && name !== 'expo-apple-authentication';
  });

  if (hasNativeGoogleConfiguration) {
    plugins.push(['react-native-nitro-google-signin', { iosUrlScheme }]);
    plugins.push('./plugins/with-google-sign-in-redirect');
  }
  if (!plugins.some((plugin) => (typeof plugin === 'string' ? plugin : plugin[0]) === 'expo-secure-store')) {
    plugins.push(['expo-secure-store', { configureAndroidBackup: false }]);
  }
  plugins.push(['./plugins/with-optional-apple-sign-in', { enabled: appleSharingEnabled }]);
  plugins.push('./plugins/with-sharing-private-storage');
  plugins.push('./plugins/with-liflow-theme');
  plugins.push('./plugins/with-android-api-styles');
  plugins.push('./plugins/with-android-security-dependencies');
  if (!plugins.some(plugin => (typeof plugin === 'string' ? plugin : plugin[0]) === '@react-native-community/datetimepicker')) {
    plugins.push('@react-native-community/datetimepicker');
  }

  return {
    ...config,
    ios: {
      ...config.ios,
      ...(appleTeamId ? { appleTeamId } : {}),
      usesAppleSignIn: appleSharingEnabled,
    },
    plugins,
    extra: {
      ...config.extra,
      googleSyncOAuth: {
        webClientId,
        iosClientId,
        configured: hasNativeGoogleConfiguration,
      },
    },
  };
};
