const fs = require('node:fs/promises');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');
const colors = require('../src/components/planner-color-values.js');

function androidColor(value) {
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) throw new Error('Invalid LiFlow theme color');
  // React Native uses RRGGBBAA; Android XML uses AARRGGBB.
  return value.length === 9 ? '#' + value.slice(7) + value.slice(1, 7) : value;
}
function themeResources(scheme) {
  if (scheme !== 'light' && scheme !== 'dark') throw new Error('Invalid LiFlow theme');
  return '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    + Object.entries(colors).map(([name, value]) => `  <color name="liflow_${name.toLowerCase()}">${androidColor(value[scheme])}</color>`).join('\n')
    + '\n</resources>\n';
}
function withLiFlowTheme(config) {
  return withDangerousMod(config, ['android', async (value) => {
    for (const [scheme, directory] of [['light', 'values'], ['dark', 'values-night']]) {
      const target = path.join(value.modRequest.platformProjectRoot, 'app/src/main/res', directory);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'liflow_colors.xml'), themeResources(scheme));
    }
    return value;
  }]);
}
module.exports = withLiFlowTheme;
module.exports.themeResources = themeResources;
