import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractPath = 'src/features/sharing/scheduler-contract.json';
const personalContractPath = 'src/features/sharing/v2/personal-scheduler-contract.json';
const personalOnly = ['src/features/sharing/v2/personal-plan.ts', 'src/features/sharing/v2/private-availability.ts'];
const formalRoots = ['src/features/sharing/v2/common-plan.ts', 'src/features/sharing/v2/actions.ts', 'src/features/sharing/v2/receiver-authority.ts',
  'src/features/sharing/v2/synchronizer.ts', 'src/features/sharing/roster.ts', 'src/features/sharing/snapshots.ts'];
export function sharedSchedulerSourceDigest(files, read = (file) => readFileSync(resolve(root, file))) {
  const digest = createHash('sha256');
  for (const file of files) {
    if ((!file.startsWith('src/') && file !== 'node_modules/moment-timezone/data/packed/latest.json') || file.includes('..')) throw new Error('Invalid scheduler source path');
    digest.update(file); digest.update('\0'); digest.update(read(file)); digest.update('\0');
  }
  return digest.digest('hex');
}
export function assertSharedSchedulerVersion(current, previous, { allowDraft = false } = {}) {
  const versionPattern = allowDraft ? /^liflow-shared-\d+(?:-draft-\d+)?$/u : /^liflow-shared-\d+$/u;
  if (!versionPattern.test(current.version) || !/^[a-f0-9]{64}$/u.test(current.sourceSha256)) throw new Error('Invalid shared scheduler contract');
  if (previous && current.version === previous.version && (current.sourceSha256 !== previous.sourceSha256 || current.timeZoneVersion !== previous.timeZoneVersion)) {
    throw new Error('Shared scheduling or tzdb changed without a shared scheduler version change. Verify cross-platform compatibility and plan the group upgrade first.');
  }
}
export function verifySharedSchedulerContract() {
  return verifyContract({ contractPath, versionSource: 'src/features/sharing/operations.ts', constant: 'SHARED_SCHEDULER_VERSION', allowDraft: false });
}
export function verifyV2SharedSchedulerContract() {
  verifyPersonalSchedulerContract();
  assertPersonalPlannerIsolation();
  return verifyContract({ contractPath: 'src/features/sharing/v2/scheduler-contract.json',
    versionSource: 'src/features/sharing/v2/payload-schema.ts', constant: 'V2_SCHEDULER_VERSION', allowDraft: true });
}
function previousRevision() {
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const sha = event.pull_request?.base?.sha ?? event.before;
    if (typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha) && !/^0+$/u.test(sha)) return sha;
  }
  return 'origin/main';
}
function readAt(base, file) { return execFileSync('git', ['show', `${base}:${file}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }); }

/** A personal recommendation never changes a signed rule, roster version or shared plan hash. */
export function assertPersonalPlannerIsolation(read = file => readFileSync(resolve(root, file), 'utf8')) {
  const seen = new Set(); const pending = [...formalRoots];
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    if (personalOnly.includes(file) || file.startsWith('src/features/calendar/')) throw new Error('Shared formal state imports personal calendar or recommendation code');
    const source = ts.createSourceFile(file, String(read(file)), ts.ScriptTarget.Latest, true);
    const visit = node => {
      let name;
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
        && !(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.length && node.importClause.namedBindings.elements.every(part => part.isTypeOnly))) name = node.moduleSpecifier;
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) name = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) name = node.arguments[0];
      if (name && ts.isStringLiteral(name) && (name.text.startsWith('.') || name.text.startsWith('@/'))) {
        const target = name.text.startsWith('@/') ? name.text.replace('@/', 'src/') : resolve(dirname(resolve(root, file)), name.text).slice(root.length);
        pending.push(/\.(?:[cm]?[jt]sx?|json)$/u.test(target) ? target : `${target}.ts`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return seen;
}
export function assertPersonalSchedulerVersion(current, previous) {
  if (!/^liflow-personal-\d+$/u.test(current.version) || !/^[a-f0-9]{64}$/u.test(current.sourceSha256)
    || JSON.stringify(current.sourceFiles) !== JSON.stringify(personalOnly)) throw new Error('Invalid personal scheduler contract');
  if (previous && current.version === previous.version && current.sourceSha256 !== previous.sourceSha256) throw new Error('Personal scheduler changed without its own version change');
}
export function verifyPersonalSchedulerContract() {
  const current = JSON.parse(readFileSync(resolve(root, personalContractPath), 'utf8')); let previous;
  try { previous = JSON.parse(readAt(previousRevision(), personalContractPath)); } catch { /* First separate local-only contract. */ }
  assertPersonalSchedulerVersion(current, previous);
  if (sharedSchedulerSourceDigest(current.sourceFiles) !== current.sourceSha256) throw new Error('Personal scheduler source differs from its contract');
  return current;
}
function verifyContract({ contractPath, versionSource, constant, allowDraft }) {
  const current = JSON.parse(readFileSync(resolve(root, contractPath), 'utf8'));
  assertSharedSchedulerVersion(current, undefined, { allowDraft });
  const source = readFileSync(resolve(root, versionSource), 'utf8');
  if (!source.includes(`export const ${constant} = '${current.version}';`)) throw new Error('Shared scheduler version differs from its contract');
  if (sharedSchedulerSourceDigest(current.sourceFiles) !== current.sourceSha256) throw new Error('Shared scheduler source changed. Verify the version and update its compatibility contract.');
  const zone = JSON.parse(readFileSync(resolve(root, 'node_modules/moment-timezone/data/packed/latest.json'), 'utf8'));
  if (zone.version !== current.timeZoneVersion) throw new Error('Shared timezone database changed without updating the contract');
  const base = previousRevision();
  let previous;
  try { previous = JSON.parse(readAt(base, contractPath)); }
  catch { /* The first sharing release has no prior contract. */ }
  // One-time split: compare every remaining formal source byte with the old revision.
  // No source can disappear except the two independently versioned local-only readers.
  if (previous && contractPath === 'src/features/sharing/v2/scheduler-contract.json'
    && previous.sourceFiles.some(file => personalOnly.includes(file))) {
    const expected = previous.sourceFiles.filter(file => !personalOnly.includes(file));
    if (JSON.stringify(current.sourceFiles) !== JSON.stringify(expected)) throw new Error('Unexpected source removed from shared scheduler contract');
    const oldSource = file => file.startsWith('node_modules/') ? readFileSync(resolve(root, file)) : readAt(base, file);
    if (sharedSchedulerSourceDigest(previous.sourceFiles, oldSource) !== previous.sourceSha256) throw new Error('Previous scheduler source or timezone data cannot be verified');
    previous = { ...previous, sourceFiles: expected, sourceSha256: sharedSchedulerSourceDigest(expected, oldSource) };
  }
  assertSharedSchedulerVersion(current, previous, { allowDraft });
  return current;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const current of [verifySharedSchedulerContract(), verifyV2SharedSchedulerContract()]) process.stdout.write(`Shared scheduler ${current.version} / tzdb ${current.timeZoneVersion}: PASS\n`);
}
