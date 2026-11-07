const fs = require('node:fs');
const path = require('node:path');

// Official fixes for GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249.
// Keep legacy callable minimatch v3 consumers separate through a scoped override.
// A new upstream version must pass the cancellation, matching and Expo checks.
function verify(root = path.join(__dirname, '../node_modules')) {
  for (const [name, expected] of [['glob', '14.0.4'], ['minimatch', '11.0.5']]) {
    const installed = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
    if (installed.version !== expected) throw new Error(`${name} changed; review its security and toolchain compatibility.`);
  }
}
if (require.main === module) verify();
module.exports = { verify };
