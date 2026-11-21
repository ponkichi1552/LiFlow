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
// Reviewed local implementation revisions of the same signed scheduler.
// Unknown digests and downgrades still require a signed version change.
const draft58Implementations = [
  { storage: 1, verifier: 1, calendarProjection: 1, digest: 'e64907a510fe40ca4dc19e131b912ed02b4aa2fa7a81c4fb0c1b616af92dbe25' },
  { storage: 2, verifier: 1, calendarProjection: 1, digest: 'e075b9fefabd0a742bfdc14b5b0da442dcb01d1b37aa76ab6abd3c6a46902f53' },
  { storage: 2, verifier: 2, calendarProjection: 2, digest: 'f77ef950f6d51a38ff6b8420c1a15c3d06407d02061c19cdd64ca6dd2cd7474c' },
  { storage: 2, verifier: 2, calendarProjection: 3, digest: '3fe706c158b3016b0e6040364f6e9ed4d229895a12434db0a7bfbf6d2a2c9519' },
  { storage: 2, verifier: 2, calendarProjection: 3, calendarRegistration: 2, digest: '4d4f6013fa6dce7d4c7b25ac35aee24ddf41f3eba5ff92d52f2ac79913b636a0' },
  // Only the XCFramework packaging changed. Both static archives are byte-identical.
  { storage: 2, verifier: 2, calendarProjection: 3, calendarRegistration: 2, digest: 'fa775cc74276976e323a119d933431bcdcef0a62b2943e18fb53664ccecc5d48' },
  // Preserve the same facts and scheduler while archiving authenticated events after the local commit.
  { storage: 3, verifier: 2, calendarProjection: 3, calendarRegistration: 2, digest: '38dbf9826dfa0542e663df946b2ef893983dee98f42838ccb90249678e1723bd' },
  // An empty outbox no longer needs another read. Fact, receipt and plan formats are identical.
  { storage: 3, verifier: 2, calendarProjection: 3, calendarRegistration: 2, digest: 'd997df2aff16aa0bb2fc3331b983b7e923876075eda2472782fae782d4875f99' },
  // Reuse locally verified history and accepted transport bytes. Signed facts and scheduling are identical.
  { storage: 3, verifier: 2, calendarProjection: 3, calendarRegistration: 2, digest: '2aa500006542d32af195f3a96fbc83a6508b072db93c45a680dd6d6594ce86f7' },
  // A missing model uses the existing string fields on the wire. Known models and scheduling are identical.
  { storage: 3, verifier: 2, calendarProjection: 3, calendarRegistration: 2, digest: '9ba7ff1ae0c70767d81fe57c7538fafafdf05d77ba15cb25e01cd3368256aa5b' },
];
const draft58ImplementationIndex = manifest => draft58Implementations.findIndex(({ storage, verifier, calendarProjection, calendarRegistration = 1, digest }) =>
  manifest.sourceSha256 === digest && (manifest.receiveStorageRevision ?? 1) === storage
  && (manifest.signatureVerificationRevision ?? 1) === verifier && (manifest.calendarProjectionRevision ?? 1) === calendarProjection
  && (manifest.calendarRegistrationRevision ?? 1) === calendarRegistration);
export function sharedSchedulerSourceDigest(files, read = (file) => readFileSync(resolve(root, file))) {
  const digest = createHash('sha256');
  for (const file of files) {
    if ((!file.startsWith('src/') && !file.startsWith('modules/liflow-ed25519/') && file !== 'node_modules/moment-timezone/data/packed/latest.json') || file.includes('..')) throw new Error('Invalid scheduler source path');
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
export function readPreviousSchedulerContract(base, file, run = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })) {
  // Only a provably absent path is a first release. A missing base commit,
  // unreadable Git object or malformed JSON must never disable compatibility checks.
  run(['rev-parse', '--verify', `${base}^{commit}`]);
  const paths = String(run(['ls-tree', '--name-only', base, '--', file])).trim();
  if (!paths) return undefined;
  if (paths !== file) throw new Error('Previous scheduler contract path is invalid');
  return JSON.parse(String(run(['show', `${base}:${file}`])));
}

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
  const current = JSON.parse(readFileSync(resolve(root, personalContractPath), 'utf8'));
  const previous = readPreviousSchedulerContract(previousRevision(), personalContractPath);
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
  let previous = readPreviousSchedulerContract(base, contractPath);
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
  if (contractPath === 'src/features/sharing/v2/scheduler-contract.json' && current.version === 'liflow-shared-2-draft-58'
    && previous?.version === current.version) {
    const from = draft58ImplementationIndex(previous);
    if (from >= 0 && draft58ImplementationIndex(current) > from) previous = { ...previous, sourceSha256: current.sourceSha256 };
  }
  assertSharedSchedulerVersion(current, previous, { allowDraft });
  return current;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const current of [verifySharedSchedulerContract(), verifyV2SharedSchedulerContract()]) process.stdout.write(`Shared scheduler ${current.version} / tzdb ${current.timeZoneVersion}: PASS\n`);
}
