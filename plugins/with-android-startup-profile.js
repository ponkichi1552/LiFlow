const { withAndroidManifest, withAppBuildGradle, withDangerousMod, withMainActivity, withMainApplication } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const { copyFile, mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

// Baseline rules also cover opening Calendar. Keep its secondary libraries out
// of the primary DEX budget reserved for loading and interacting with the first view.
const launchPackages = [
  'androidx/activity/', 'androidx/appcompat/app/', 'androidx/core/splashscreen/',
  'androidx/core/view/', 'androidx/fragment/app/', 'androidx/lifecycle/', 'androidx/savedstate/',
  'com/facebook/fbjni/', 'com/facebook/hermes/', 'com/facebook/jni/', 'com/facebook/react/', 'com/facebook/soloader/',
  'com/swmansion/gesturehandler/', 'com/swmansion/reanimated/', 'com/swmansion/rnscreens/',
  'com/swmansion/worklets/', 'com/th3rdwave/safeareacontext/',
  'expo/modules/adapters/react/', 'expo/modules/asset/', 'expo/modules/core/', 'expo/modules/crypto/',
  'expo/modules/kotlin/', 'expo/modules/securestore/', 'expo/modules/splashscreen/', 'expo/modules/sqlite/',
  'expo/modules/symbols/', 'jp/jphacks/tkb2633/',
];

const startupProvider = 'androidx.startup.InitializationProvider';
const workInitializer = 'androidx.work.WorkManagerInitializer';

function deferWorkManager(manifest) {
  const application = manifest.manifest.application?.[0];
  if (!application) throw new Error('Android startup optimization requires the application manifest.');
  manifest.manifest.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
  const providers = (application.provider ??= []);
  let provider = providers.find(value => value.$['android:name'] === startupProvider);
  if (!provider) {
    provider = { $: { 'android:name': startupProvider, 'android:authorities': '${applicationId}.androidx-startup',
      'android:exported': 'false', 'tools:node': 'merge' } };
    providers.push(provider);
  }
  provider['meta-data'] = [...(provider['meta-data'] ?? []).filter(value => value.$['android:name'] !== workInitializer),
    { $: { 'android:name': workInitializer, 'android:value': 'androidx.startup', 'tools:node': 'remove' } }];
  return manifest;
}

function provideWorkManagerConfiguration(source) {
  const application = /class MainApplication : Application\(\), ReactApplication(, androidx\.work\.Configuration\.Provider)? \{/u;
  if (!application.test(source)) throw new Error('Android startup optimization requires the SDK58 Kotlin MainApplication.');
  const contents = source.replace(application, 'class MainApplication : Application(), ReactApplication, androidx.work.Configuration.Provider {');
  return mergeContents({ tag: 'liflow-work-manager-on-demand', src: contents, anchor: application, offset: 1, comment: '//',
    newSrc: '  override val workManagerConfiguration: androidx.work.Configuration\n    get() = androidx.work.Configuration.Builder().build()\n' }).contents;
}

function addWorkManagerDependency(source) {
  // Expo BackgroundTask and Widgets use the same WorkManager release and initialize via getInstance(context).
  return mergeContents({ tag: 'liflow-work-manager-on-demand', src: source, anchor: /^dependencies \{/mu, offset: 1, comment: '//',
    newSrc: "    implementation('androidx.work:work-runtime:2.10.5')" }).contents;
}

function preloadLauncherReactHost(source) {
  const anchor = /^\s*override fun onCreate\(savedInstanceState: Bundle\?\) \{/mu;
  return mergeContents({ tag: 'liflow-preload-launcher-react-host', src: source, anchor, offset: 1, comment: '//',
    newSrc: `    val coldLauncher = !BuildConfig.DEBUG && savedInstanceState == null && intent?.action == android.content.Intent.ACTION_MAIN
      && intent?.hasCategory(android.content.Intent.CATEGORY_LAUNCHER) == true
    if (coldLauncher) {
      (application as com.facebook.react.ReactApplication).reactHost?.start()
    }` }).contents;
}

function withAndroidStartupProfile(config) {
  config = withAndroidManifest(config, mod => { mod.modResults = deferWorkManager(mod.modResults); return mod; });
  config = withMainApplication(config, mod => { mod.modResults.contents = provideWorkManagerConfiguration(mod.modResults.contents); return mod; });
  config = withAppBuildGradle(config, mod => { mod.modResults.contents = addWorkManagerDependency(mod.modResults.contents); return mod; });
  config = withMainActivity(config, mod => {
    // An OTA updates delegate may select a bundle asynchronously. Let Expo
    // load that bundle itself; only the embedded release starts in parallel.
    let embeddedOnly = mod.updates?.enabled === false;
    if (!embeddedOnly) {
      try { require.resolve('expo-updates/package.json', { paths: [mod.modRequest.projectRoot] }); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; embeddedOnly = true; }
    }
    if (embeddedOnly) mod.modResults.contents = preloadLauncherReactHost(mod.modResults.contents);
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'baselineProfiles');
    const baselineSource = path.join(__dirname, 'android', 'baseline-prof.txt');
    await mkdir(directory, { recursive: true });
    // AGP rewrites the source method names for the actual release DEX files.
    await copyFile(baselineSource, path.join(directory, 'baseline-prof.txt'));
    // R8 uses the startup subset at build time to keep launch and input code together.
    const baseline = await readFile(baselineSource, 'utf8');
    const startup = baseline.split(/\r?\n/u).filter(rule => {
      const match = /^([HSP]*)L([^;]+);/u.exec(rule);
      return match && (!match[1] || match[1].includes('S')) && launchPackages.some(prefix => match[2].startsWith(prefix));
    });
    await writeFile(path.join(directory, 'startup-prof.txt'), startup.join('\n') + '\n');
    return mod;
  }]);
}

module.exports = withAndroidStartupProfile;
module.exports.deferWorkManager = deferWorkManager;
module.exports.provideWorkManagerConfiguration = provideWorkManagerConfiguration;
module.exports.addWorkManagerDependency = addWorkManagerDependency;
module.exports.preloadLauncherReactHost = preloadLauncherReactHost;
