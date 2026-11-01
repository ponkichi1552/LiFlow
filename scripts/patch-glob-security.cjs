const fs = require('node:fs');
const path = require('node:path');

// Backports for the Expo 58 toolchain. Keep its public APIs and pinned majors.
// Upstream MIT fixes: node-glob 4682e8c (GHSA-3g3m-2fjr-6pw4),
// minimatch 77a0f5c (GHSA-g3hv-75wg-m249). npm audit remains version-based.
function patchGlob(source) {
  const before = 'if (this.signal?.aborted)\n            cb();';
  const after = 'if (this.signal?.aborted)\n            return cb();';
  const vulnerable = source.split(before).length - 1;
  const repaired = source.split(after).length - 1;
  if (vulnerable + repaired !== 4) throw new Error('Glob abort branches changed; review the security backport.');
  return source.split(before).join(after);
}
function patchMinimatch(source) {
  const transforms = [
    ['firstPhasePreProcess(globParts) {\n', 'firstPhasePreProcess(globParts) {\n        const { braceExpandMax = 100_000 } = this.options;\n'],
    ["p2 === '..') {", "p2 === '..' || globParts.length >= braceExpandMax) {"],
    ['secondPhasePreProcess(globParts) {\n', 'secondPhasePreProcess(globParts) {\n        if (globParts.length > 1000) return globParts;\n'],
  ];
  for (const [before, after] of transforms) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error('Minimatch optimization changed; review the security backport.');
    source = source.replace(before, after);
  }
  return source;
}
function apply(root = path.join(__dirname, '../node_modules')) {
  for (const [name, version, file, patch] of [['glob', '13.0.6', 'walker.js', patchGlob], ['minimatch', '10.2.6', 'index.js', patchMinimatch]]) {
    const directory = path.join(root, name);
    if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version !== version) throw new Error(`${name} changed; check whether its security backport is still needed.`);
    for (const format of ['commonjs', 'esm']) {
      const target = path.join(directory, 'dist', format, file); const before = fs.readFileSync(target, 'utf8'); const after = patch(before);
      if (after !== before) fs.writeFileSync(target, after);
    }
  }
}
if (require.main === module) apply();
module.exports = { apply, patchGlob, patchMinimatch };
