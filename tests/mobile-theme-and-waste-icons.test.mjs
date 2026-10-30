import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { plannerLightColors, plannerDarkColors } from '../src/components/planner-theme.ts';
import { wasteTypeColor, wasteTypeIcon } from '../src/features/waste/type-appearance.ts';
import { WASTE_TYPES } from '../src/features/waste/waste-types.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const require = createRequire(import.meta.url);
const { themeResources } = require('../plugins/with-liflow-theme.js');
const values = require('../src/components/planner-color-values.js');
function luminance(value) {
  const [r, g, b] = value.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}
function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); }

test('mobile light and dark themes keep text actions warnings and controls readable', () => {
  for (const colors of [plannerLightColors, plannerDarkColors]) {
    for (const [fg, bg] of [['ink', 'background'], ['muted', 'surface'], ['accent', 'surface'], ['accentInk', 'accent'], ['gold', 'goldSoft'], ['warning', 'warningSoft']]) {
      assert.ok(contrast(colors[fg], colors[bg]) >= 4.5, `${fg}/${bg}: ${contrast(colors[fg], colors[bg])}`);
    }
  }
  assert.equal(plannerDarkColors.background, '#171C24');
  assert.notEqual(plannerLightColors.background, plannerDarkColors.background);
});

test('Android day and night resources cover every shared color and preserve alpha order', () => {
  for (const scheme of ['light', 'dark']) {
    const xml = themeResources(scheme);
    for (const [name, color] of Object.entries(values)) {
      const expected = color[scheme].length === 9 ? '#' + color[scheme].slice(7) + color[scheme].slice(1, 7) : color[scheme];
      assert.ok(xml.includes(`name="liflow_${name.toLowerCase()}">${expected}</color>`));
    }
  }
  assert.equal(JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo.userInterfaceStyle, 'automatic');
  const native = readFileSync(new URL('../src/components/planner-colors.native.ts', import.meta.url), 'utf8');
  assert.match(native, /DynamicColorIOS/); assert.match(native, /PlatformColor/);
  assert.match(readFileSync(new URL('../app.config.js', import.meta.url), 'utf8'), /with-liflow-theme/);
});

test('waste aliases retain one icon identity and bottles PET bottles and cans stay distinct', () => {
  for (const item of WASTE_TYPES) for (const alias of item.aliases) assert.equal(wasteTypeIcon(alias), wasteTypeIcon(item.label), `${item.label}: ${alias}`);
  assert.equal(new Set(['びん', 'ペットボトル', '缶'].map(wasteTypeIcon)).size, 3);
  assert.equal(wasteTypeIcon('自治体独自の収集'), 'trash');
  for (const item of WASTE_TYPES) assert.ok(contrast(wasteTypeColor(item.label, 'dark'), plannerDarkColors.background) >= 4.5, item.label);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} waste marks use different vector shapes with their original readable labels`, () => {
    const shapes = [];
    for (const label of ['びん', 'ペットボトル', '缶']) {
      const screen = screenHarness('src/components/waste-type-icon.tsx', { exportName: 'WasteTypeLabel', platform, colorScheme: 'dark', props: { label } });
      assert.ok(screen.text().includes(label));
      assert.ok(screen.nodes().some(node => node.type === 'Svg'));
      shapes.push(JSON.stringify(screen.nodes().filter(node => node.type === 'Path' || node.type === 'Ellipse').map(node => node.props)));
    }
    assert.equal(new Set(shapes).size, 3);
  });
}
