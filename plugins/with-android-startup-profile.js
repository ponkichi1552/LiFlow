const { withDangerousMod } = require('@expo/config-plugins');
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

module.exports = function withAndroidStartupProfile(config) {
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
};
