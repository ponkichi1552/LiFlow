const { withAppBuildGradle } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

// These transitive SDK58 runtime dependencies have published security fixes.
// Constraints set a minimum without forcing a downgrade when Expo moves ahead.
const minimumVersions = [
  ['commons-io:commons-io', '2.14.0', 'GHSA-gwrp-pvrq-jmwv and CVE-2024-47554'],
  ['com.google.code.gson:gson', '2.8.9', 'GHSA-4jrv-ppp4-jm57'],
  ['com.google.guava:guava', '33.7.2-android', 'GHSA-xxph-c9ww-hj94 and earlier temporary-file advisories'],
];

function addSecurityConstraints(contents, language = 'groovy') {
  if (language !== 'groovy') throw new Error('LiFlow native security constraints require a Groovy app build.gradle');
  const body = minimumVersions.map(([coordinate, version, reason]) =>
    `        implementation('${coordinate}') {\n            version { require('${version}') }\n            because '${reason}'\n        }`).join('\n');
  return mergeContents({
    tag: 'liflow-native-security-minimums', src: contents,
    anchor: /^dependencies\s*\{/mu, offset: 1, comment: '//',
    newSrc: `    constraints {\n${body}\n    }`,
  }).contents;
}

module.exports = config => withAppBuildGradle(config, value => {
  value.modResults.contents = addSecurityConstraints(value.modResults.contents, value.modResults.language);
  return value;
});
module.exports.addSecurityConstraints = addSecurityConstraints;
module.exports.minimumVersions = minimumVersions;
