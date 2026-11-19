const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = require('react-native/package.json').version;
const patch = path.join(root, 'patches', 'react-native-0.88.1-android-ui-manager.patch');
if (version !== '0.88.1') {
  throw new Error('Review Android UIManager startup deferral against the new React Native version.');
}

function apply(...options) {
  const result = spawnSync('git', ['apply', ...options, patch], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

if (apply('--reverse', '--check').status !== 0) {
  const result = apply();
  if (result.status !== 0) throw new Error(`Could not apply Android UIManager startup deferral.\n${result.stderr}`);
}
