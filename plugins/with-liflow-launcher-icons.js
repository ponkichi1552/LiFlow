const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

function setLauncherManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:icon'] = '@mipmap/liflow_launcher';
  application.$['android:roundIcon'] = '@mipmap/liflow_launcher';
  return manifest;
}

function adaptiveIconXml() {
  // Reuse the exact iOS artwork. 18dp per side maps the 108dp layer to its 72dp viewport.
  // Balance the white visual mass around the center while retaining its 72dp size and circular safe area.
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/iconBackground" />
  <foreground>
    <inset android:drawable="@mipmap/ic_launcher_foreground"
      android:insetLeft="12.7551%" android:insetTop="11.4461%"
      android:insetRight="20.578234%" android:insetBottom="21.887234%" />
  </foreground>
</adaptive-icon>
`;
}

function withLiFlowLauncherIcons(config) {
  config = withAndroidManifest(config, (mod) => {
    mod.modResults = setLauncherManifest(mod.modResults);
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const resources = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res');
    const adaptive = path.join(resources, 'mipmap-anydpi-v26');
    const values = path.join(resources, 'values');
    await fs.mkdir(adaptive, { recursive: true });
    await fs.mkdir(values, { recursive: true });
    await fs.writeFile(path.join(adaptive, 'liflow_launcher.xml'), adaptiveIconXml());
    // Older launchers use Expo's ordinary bitmap of the same shared artwork.
    await fs.writeFile(path.join(values, 'liflow_launcher.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources><item type="mipmap" name="liflow_launcher">@mipmap/ic_launcher</item></resources>\n');
    return mod;
  }]);
}

module.exports = withLiFlowLauncherIcons;
module.exports.setLauncherManifest = setLauncherManifest;
module.exports.adaptiveIconXml = adaptiveIconXml;
