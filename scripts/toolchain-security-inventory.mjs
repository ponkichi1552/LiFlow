import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

/** Include nested copies from both reproducible dependency trees, not just root require.resolve(). */
export function toolchainSecurityInventory(root = resolve(import.meta.dirname, '..')) {
  const rows = [];
  for (const prefix of ['', 'server/appliance-care-api/']) {
    const lock = JSON.parse(readFileSync(resolve(root, prefix, 'package-lock.json'), 'utf8'));
    for (const [path, installed] of Object.entries(lock.packages)) {
      if (!/\/(glob|minimatch)$/u.test(path)) continue;
      const directory = resolve(root, prefix, path); const packagePath = resolve(directory, 'package.json');
      if (!existsSync(packagePath)) throw new Error('Missing audited dependency: ' + relative(root, directory));
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (pkg.version !== installed.version) throw new Error('Audited dependency differs from its lockfile');
      const files = pkg.name === 'glob' ? ['dist/commonjs/walker.js', 'dist/esm/walker.js',
        'dist/commonjs/index.min.js', 'dist/esm/index.min.js']
        : pkg.version === '3.1.5' ? ['minimatch.js'] : ['dist/commonjs/index.js', 'dist/esm/index.js'];
      rows.push({ path: relative(root, directory), name: pkg.name, version: pkg.version,
        files: files.map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(resolve(directory, file))).digest('hex') })) });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, dependencies: toolchainSecurityInventory() }, null, 2) + '\n');
}
