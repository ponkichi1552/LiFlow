const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

function setLauncherManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  // Existing native projects may still point to the old, additionally inset drawable.
  application.$['android:icon'] = '@mipmap/ic_launcher';
  application.$['android:roundIcon'] = '@mipmap/ic_launcher_round';
  return manifest;
}

function withLiFlowLauncherIcons(config) {
  return withAndroidManifest(config, (mod) => {
    mod.modResults = setLauncherManifest(mod.modResults);
    return mod;
  });
}

module.exports = withLiFlowLauncherIcons;
module.exports.setLauncherManifest = setLauncherManifest;
