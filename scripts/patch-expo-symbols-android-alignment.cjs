const fs = require('node:fs');
const path = require('node:path');

/** Expo 58 renders Material icons as text inside a fixed square. Android font padding and accessibility text scaling clip that square. */
function alignMaterialSymbol(source, compiled = false) {
  if (source.includes('includeFontPadding: false') && (source.includes('allowFontScaling={false}') || source.includes('allowFontScaling: false'))) return source;
  const text = compiled ? '"aria-hidden": true,' : 'aria-hidden';
  if (!source.includes(text) || !/lineHeight: size,?/u.test(source)) throw new Error('Expo Symbols renderer changed; review its Android icon alignment before updating.');
  return source.replace(text, compiled ? '"aria-hidden": true,\n            allowFontScaling: false,' : 'aria-hidden\n        allowFontScaling={false}')
    .replace(/lineHeight: size,?/u, 'lineHeight: size,\n          includeFontPadding: false,\n          textAlign: "center",\n          textAlignVertical: "center",');
}
if (require.main === module) {
  const root = path.join(__dirname, '../node_modules/expo-symbols');
  if (!fs.existsSync(root)) throw new Error('Install Expo Symbols before applying its Android alignment correction.');
  for (const file of ['src/SymbolView.tsx', 'build/SymbolView.js']) {
    const target = path.join(root, file); const before = fs.readFileSync(target, 'utf8'); const next = alignMaterialSymbol(before, file.endsWith('.js'));
    if (next !== before) fs.writeFileSync(target, next);
  }
}
module.exports = { alignMaterialSymbol };
