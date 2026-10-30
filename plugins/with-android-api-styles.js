const fs = require('node:fs/promises');
const path = require('node:path');
const { withFinalizedMod, AndroidConfig, XML } = require('expo/config-plugins');

// SDK58 generators put these framework attributes in the API24 base style.
// Keep complete style bags in qualified resources: partial bags can lose base items.
const minimumApi = new Map([
  ['android:windowLightNavigationBar', 27],
  ['android:enforceNavigationBarContrast', 29],
  ['android:windowSplashScreenBehavior', 33],
]);
function qualifyThemeStyles(input) {
  const base = structuredClone(input); const versions = new Map();
  for (const style of base.resources.style ?? []) {
    const original = structuredClone(style);
    const levels = [...new Set((style.item ?? []).map(item => minimumApi.get(item.$.name)).filter(Boolean))].sort((a, b) => a - b);
    style.item = (style.item ?? []).filter(item => !minimumApi.has(item.$.name));
    for (const api of levels) {
      const value = versions.get(api) ?? { resources: { ...(input.resources.$ ? { $: structuredClone(input.resources.$) } : {}), style: [] } };
      value.resources.style.push({ ...original, item: original.item.filter(item => (minimumApi.get(item.$.name) ?? 24) <= api) });
      versions.set(api, value);
    }
  }
  return { base, versions };
}
module.exports = config => withFinalizedMod(config, ['android', async value => {
  const resources = path.join(value.modRequest.platformProjectRoot, 'app/src/main/res');
  const file = path.join(resources, 'values/styles.xml');
  const original = await AndroidConfig.Resources.readResourcesXMLAsync({ path: file });
  const { base, versions } = qualifyThemeStyles(original);
  for (const [api, xml] of versions) {
    const folder = path.join(resources, `values-v${api}`); await fs.mkdir(folder, { recursive: true });
    await XML.writeXMLAsync({ path: path.join(folder, 'liflow_api_styles.xml'), xml });
  }
  await XML.writeXMLAsync({ path: file, xml: base });
  return value;
}]);
module.exports.qualifyThemeStyles = qualifyThemeStyles;
