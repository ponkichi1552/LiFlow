import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compileModsAsync } = require('expo/config-plugins');
const optionalApple = require('../plugins/with-optional-apple-sign-in');
const autoApple = require('../node_modules/@expo/prebuild-config/build/plugins/unversioned/expo-apple-authentication').default;
const storage = require('../plugins/with-sharing-private-storage');
const startup = require('../plugins/with-android-startup-profile');

test('Apple sharing capability follows the explicit flag even after Expo automatically reapplies installed plugins', async () => {
  for (const enabled of [false, true]) {
    const config = optionalApple({ name: 'Native contract', slug: 'native-contract',
      _internal: { projectRoot: process.cwd() },
      ios: { entitlements: { 'com.apple.developer.applesignin': ['Default'],
        'com.apple.security.application-groups': ['group.existing.widget'] } },
    }, { enabled });
    const result = await compileModsAsync(autoApple(config), { projectRoot: process.cwd(), introspect: true, platforms: ['ios'] });
    assert.deepEqual(result.ios.entitlements['com.apple.security.application-groups'], ['group.existing.widget']);
    assert.deepEqual(result.ios.entitlements['com.apple.developer.applesignin'], enabled ? ['Default'] : undefined);
  }
});

test('shared database native directories exclude OS backups without changing personal SQLite backup or deleting business data', () => {
  const android = 'class MainApplication {\n  override fun onCreate() {\n    super.onCreate()\n  }\n}';
  const ios = 'class AppDelegate: ExpoAppDelegate {\n  func application() {\n    let delegate = ReactNativeDelegate()\n  }\n}';
  const kotlin = storage.androidStorage(android); const swift = storage.iosStorage(ios);
  assert.equal(storage.androidStorage(kotlin), kotlin); assert.equal(storage.iosStorage(swift), swift);
  assert.match(kotlin, /java\.io\.File\(noBackupFilesDir, "LiFlowSharedSQLite"\)/);
  assert.match(kotlin, /sharingMarker\.readText\(\) != expectedMarker[\s\S]*temporaryMarker\.renameTo\(sharingMarker\)/);
  assert.match(kotlin, /catch[\s\S]*sharingMarker\.delete\(\)/);
  assert.match(swift, /values\.isExcludedFromBackup = true/);
  assert.match(swift, /resourceValues[\s\S]*isExcludedFromBackup == true/);
  assert.match(swift, /completeUntilFirstUserAuthentication/);
  assert.match(swift, /initializeLiFlowSharedStorage\(\)[\s\S]*let delegate = ReactNativeDelegate/);
  assert.doesNotMatch(kotlin, /sharedDirectory\.delete|deleteDatabase/);
  assert.doesNotMatch(swift, /removeItem\(at: shared\)/);
  for (const xml of [storage.backupRules, storage.extractionRules]) {
    assert.match(xml, /SecureStore/); assert.match(xml, /google_signin_prefs\.xml/);
    assert.doesNotMatch(xml, /<include|housework\.db|domain="file"/);
  }
  assert.throws(() => storage.androidStorage('unsupported'));
  assert.throws(() => storage.iosStorage('unsupported'));
});

test('Android uses the default WorkManager configuration on demand and retains other App Startup initializers', () => {
  const emoji = { $: { 'android:name': 'androidx.emoji2.text.EmojiCompatInitializer', 'android:value': 'androidx.startup' } };
  const provider = { $: { 'android:name': 'androidx.startup.InitializationProvider' }, 'meta-data': [emoji] };
  const manifest = { manifest: { $: {}, application: [{ provider: [provider] }] } };
  startup.deferWorkManager(startup.deferWorkManager(manifest));
  assert.deepEqual(provider['meta-data'], [emoji, { $: { 'android:name': 'androidx.work.WorkManagerInitializer',
    'android:value': 'androidx.startup', 'tools:node': 'remove' } }]);
  const app = startup.provideWorkManagerConfiguration('class MainApplication : Application(), ReactApplication {\n}');
  assert.equal(startup.provideWorkManagerConfiguration(app), app);
  assert.match(app, /androidx\.work\.Configuration\.Provider/);
  assert.match(app, /override val workManagerConfiguration:[\s\S]*Configuration\.Builder\(\)\.build\(\)/);
  const gradle = startup.addWorkManagerDependency('dependencies {\n}');
  assert.equal(startup.addWorkManagerDependency(gradle), gradle);
  assert.match(gradle, /implementation\('androidx\.work:work-runtime:2\.10\.5'\)/);
});

test('Android starts the embedded React host in parallel with its release launcher activity', () => {
  const activity = startup.preloadLauncherReactHost('class MainActivity {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(null)\n  }\n}');
  assert.equal(startup.preloadLauncherReactHost(activity), activity);
  assert.match(activity, /!BuildConfig\.DEBUG[\s\S]*ACTION_MAIN[\s\S]*CATEGORY_LAUNCHER[\s\S]*reactHost\?\.start\(\)[\s\S]*super\.onCreate\(null\)/);
});
