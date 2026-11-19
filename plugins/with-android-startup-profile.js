const { withDangerousMod } = require('@expo/config-plugins');
const { copyFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

module.exports = function withAndroidStartupProfile(config) {
  return withDangerousMod(config, ['android', async mod => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'baselineProfiles');
    await mkdir(directory, { recursive: true });
    // AGP rewrites the source method names for the actual release DEX files.
    await copyFile(path.join(__dirname, 'android', 'baseline-prof.txt'), path.join(directory, 'baseline-prof.txt'));
    return mod;
  }]);
};
