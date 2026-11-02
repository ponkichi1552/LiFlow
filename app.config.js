module.exports = ({ config }) => {
  const storeDistribution = process.env.EAS_BUILD_PROFILE === 'production' || process.env.LIFLOW_DISTRIBUTION === 'store';
  if (storeDistribution) {
    if (process.env.EXPO_PUBLIC_LIFLOW_SUBSCRIPTIONS !== 'required') throw new Error('Store builds require verified LiFlow subscriptions.');
    for (const field of ['EXPO_PUBLIC_APPLE_SUBSCRIPTION_PRODUCT_ID', 'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_PRODUCT_ID',
      'EXPO_PUBLIC_GOOGLE_SUBSCRIPTION_BASE_PLAN_ID', 'EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY',
      'EXPO_PUBLIC_APPLIANCE_CARE_API_URL', 'EXPO_PUBLIC_LIFLOW_TERMS_URL', 'EXPO_PUBLIC_LIFLOW_PRIVACY_URL']) {
      if (!process.env[field]?.trim()) throw new Error(`Store billing configuration is required: ${field}`);
    }
    if (!/^[a-f0-9]{64}$/.test(process.env.EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY)) throw new Error('Invalid subscription verification public key.');
    for (const field of ['EXPO_PUBLIC_APPLIANCE_CARE_API_URL', 'EXPO_PUBLIC_LIFLOW_TERMS_URL', 'EXPO_PUBLIC_LIFLOW_PRIVACY_URL']) {
      const url = new URL(process.env[field]);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Store services and legal links must use HTTPS.');
    }
  }
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
    return name !== 'react-native-nitro-google-signin' && name !== 'expo-apple-authentication' && name !== 'expo-iap';
  });

  if (hasNativeGoogleConfiguration) {
    plugins.push(['react-native-nitro-google-signin', { iosUrlScheme }]);
    plugins.push('./plugins/with-google-sign-in-redirect');
  }
  if (!plugins.some((plugin) => (typeof plugin === 'string' ? plugin : plugin[0]) === 'expo-secure-store')) {
    plugins.push(['expo-secure-store', { configureAndroidBackup: false }]);
  }
  // Expo's isolated transactions open a new native connection. A PRAGMA on
  // the original connection cannot enable its foreign-key constraints.
  const sqliteIndex = plugins.findIndex(plugin => (typeof plugin === 'string' ? plugin : plugin[0]) === 'expo-sqlite');
  const sqliteOptions = sqliteIndex < 0 || typeof plugins[sqliteIndex] === 'string' ? {} : plugins[sqliteIndex][1] ?? {};
  const sqliteFlags = (flags = '') => `${flags.replace(/(?:^|\s)-DSQLITE_DEFAULT_FOREIGN_KEYS(?:=\S+)?(?=\s|$)/g, ' ').trim()} -DSQLITE_DEFAULT_FOREIGN_KEYS=1`.trim();
  const sqlite = ['expo-sqlite', { ...sqliteOptions, customBuildFlags: sqliteFlags(sqliteOptions.customBuildFlags),
    ...(sqliteOptions.ios?.customBuildFlags !== undefined ? { ios: { ...sqliteOptions.ios, customBuildFlags: sqliteFlags(sqliteOptions.ios.customBuildFlags) } } : {}),
    ...(sqliteOptions.android?.customBuildFlags !== undefined ? { android: { ...sqliteOptions.android, customBuildFlags: sqliteFlags(sqliteOptions.android.customBuildFlags) } } : {}),
  }];
  if (sqliteIndex < 0) plugins.push(sqlite); else plugins[sqliteIndex] = sqlite;
  plugins.push(['./plugins/with-optional-apple-sign-in', { enabled: appleSharingEnabled }]);
  plugins.push('./plugins/with-sharing-private-storage');
  plugins.push('./plugins/with-liflow-theme');
  plugins.push('./plugins/with-android-api-styles');
  plugins.push('./plugins/with-android-security-dependencies');
  plugins.push(['expo-iap', { android: { store: 'play' } }]);
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
