#!/usr/bin/env node
// Read-only LiFlow native preflight. It does not install, build, or access devices.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CMAKE = '3.22.1';
const failures = [];
const passes = [];
const fail = (name, fix) => failures.push(`${name}: ${fix}`);
const pass = (name, detail = '') => passes.push(`${name}${detail ? ` — ${detail}` : ''}`);
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const run = (command, args = []) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
};

function moduleCxxLinks(root) {
  const modules = [];
  const links = [];
  let checked = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const first = path.join(root, entry.name);
    if (entry.name.startsWith('@')) {
      if (entry.isDirectory() || entry.isSymbolicLink()) for (const child of readdirSync(first, { withFileTypes: true }))
        if (child.isDirectory() || child.isSymbolicLink()) modules.push(path.join(first, child.name));
    } else if (entry.isDirectory() || entry.isSymbolicLink()) modules.push(first);
  }
  for (const module of modules) {
    const candidate = path.join(module, 'android/.cxx');
    try { const stat = lstatSync(candidate); checked += 1; if (stat.isSymbolicLink()) links.push(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { checked, links };
}

function checkProviderSources(root) {
  const project = path.join(root, 'ios/LiFlow.xcodeproj/project.pbxproj');
  if (!existsSync(project)) { pass('Generated provider source check', 'Xcode project not generated yet'); return; }
  const section = readFileSync(project, 'utf8').match(/\/\* Begin PBXSourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXSourcesBuildPhase section \*\//u)?.[1];
  const phases = [...(section ?? '').matchAll(/([A-F0-9]+) \/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/gu)];
  const duplicates = phases.filter(([, , files]) => (files.match(/ExpoModulesProvider\.swift in Sources/gu) ?? []).length > 1);
  if (duplicates.length) fail('Duplicate ExpoModulesProvider source', `inspect Sources phase(s) ${duplicates.map(([, id]) => id).join(', ')}; keep one provider per target and use in-source Pods by default`);
  else pass('Generated provider source check', `${phases.length} Sources phases; no duplicate provider in a target`);
}

function mountType(candidate) {
  if (!candidate.startsWith('/Volumes/')) return undefined;
  const volume = path.join('/Volumes', candidate.slice('/Volumes/'.length).split('/')[0]);
  const row = run('mount').split(/\r?\n/u).find(line => line.includes(` on ${volume} (`));
  return row?.match(/\(([^,]+)/u)?.[1]?.trim().toLowerCase();
}

function sdkRootFor(root) {
  const local = path.join(root, 'android/local.properties');
  if (existsSync(local)) {
    const sdkDir = readFileSync(local, 'utf8').match(/^sdk\.dir=(.*)$/mu)?.[1]?.replaceAll('\\:', ':').replaceAll('\\ ', ' ');
    if (sdkDir) {
      if (!existsSync(sdkDir)) return { error: `android/local.properties selects missing SDK: ${sdkDir}` };
      return { path: sdkDir };
    }
  }
  const fallback = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    path.join(homedir(), 'Library/Android/sdk')].find(candidate => candidate && existsSync(candidate));
  return fallback ? { path: fallback } : { error: 'set android/local.properties sdk.dir or install the Android SDK' };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--ios-app') {
    const manifestPath = path.join(path.resolve(args[1]), 'EXConstants.bundle', 'app.config');
    if (!existsSync(manifestPath)) throw new Error('The iOS app is missing Expo Constants configuration');
    const oauth = readJson(manifestPath).extra?.googleSyncOAuth;
    if (oauth?.configured !== true || ![oauth.webClientId, oauth.iosClientId].every(value => typeof value === 'string' && value.trim())) {
      throw new Error('The iOS app is missing its Google OAuth configuration');
    }
    process.stdout.write('PASS iOS app contains both Google OAuth client IDs\n');
    return;
  }
  const rootArg = args.length === 2 && args[0] === '--root' ? args[1] : args.length === 0 ? process.cwd() : undefined;
  if (!rootArg) throw new Error('Usage: node native-preflight.mjs [--root <repository-root> | --ios-app <built-app>]');
  const root = realpathSync(path.resolve(rootArg));
  const manifest = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const lockRoot = lock.packages?.[''];
  for (const name of ['expo', 'react-native']) {
    const spec = manifest.dependencies?.[name];
    const lockedSpec = lockRoot?.dependencies?.[name];
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    const installedPath = path.join(root, `node_modules/${name}/package.json`);
    const installed = existsSync(installedPath) ? readJson(installedPath).version : undefined;
    if (spec && spec === lockedSpec && version && installed === version) pass(`${name} matches manifest and lock`, version);
    else fail(`${name} lock mismatch`, `restore dependencies with npm ci after the active build/device verification`);
  }

  const sdkSelection = sdkRootFor(root);
  if (sdkSelection.error) fail('Android SDK selection', sdkSelection.error);
  else {
    const sdk = realpathSync(sdkSelection.path);
    const fs = mountType(sdk);
    if (sdk.startsWith('/Volumes/') && fs !== 'apfs') fail('Android SDK filesystem', `external SDK volume must be verified APFS; found ${fs ?? 'unknown'}`);
    else pass('Selected Android SDK', `${sdk}${fs ? ` (${fs})` : ''}`);
    const cmakeDir = path.join(sdk, 'cmake', CMAKE, 'bin');
    const source = path.join(sdk, 'cmake', CMAKE, 'source.properties');
    const revision = existsSync(source) ? readFileSync(source, 'utf8').match(/^Pkg\.Revision\s*=\s*(\S+)/mu)?.[1] : undefined;
    const cmakeOutput = run(path.join(cmakeDir, 'cmake'), ['--version']);
    const cmakeMatches = new RegExp(`cmake version ${CMAKE.replaceAll('.', '\\.')}\\b`, 'iu').test(cmakeOutput);
    const ninjaVersion = run(path.join(cmakeDir, 'ninja'), ['--version']);
    if (revision === CMAKE && cmakeMatches && ninjaVersion) pass('SDK CMake and Ninja', `${revision}; Ninja ${ninjaVersion}`);
    else fail('SDK CMake/Ninja package', `install cmake;${CMAKE} into the selected SDK with its sdkmanager`);
  }

  const appCxxLinks = [];
  for (const relative of ['android/.cxx', 'android/app/.cxx']) {
    const dir = path.join(root, relative);
    try { if (lstatSync(dir).isSymbolicLink()) appCxxLinks.push(dir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const dependencyCxx = existsSync(path.join(root, 'node_modules'))
    ? moduleCxxLinks(path.join(root, 'node_modules')) : { checked: 0, links: [] };
  const cxxLinks = [...appCxxLinks, ...dependencyCxx.links];
  if (cxxLinks.length) fail('Android .cxx symlink(s)', `after Gradle is idle, unlink only: ${cxxLinks.join(', ')}`);
  else pass('Android .cxx symlink check', `no symlinks; ${dependencyCxx.checked} dependencies with .cxx checked`);

  const modules = path.join(root, 'node_modules');
  const modulesReal = existsSync(modules) ? realpathSync(modules) : undefined;
  const podsPath = path.join(root, 'ios/Pods');
  if (!existsSync(podsPath)) fail('iOS Pods missing', 'restore from the locked Podfile with: cd ios && pod install --deployment');
  else {
    const pods = realpathSync(podsPath);
    const fs = mountType(pods);
    if (pods.startsWith('/Volumes/') && fs !== 'apfs') fail('iOS Pods filesystem', `external Pods volume must be verified APFS; found ${fs ?? 'unknown'}`);
    const expectedModules = path.resolve(pods, '..', '..', 'node_modules');
    const expectedReal = existsSync(expectedModules) ? realpathSync(expectedModules) : undefined;
    if (modulesReal && expectedReal === modulesReal) pass('Pods-relative node_modules path', 'PODS_ROOT/../../node_modules resolves to this checkout');
    else fail('Pods-relative node_modules path', 'restore the external LiFlow/node_modules link to this checkout, or use in-project ios/Pods');

    const podLock = path.join(root, 'ios/Podfile.lock');
    const manifestLock = path.join(pods, 'Manifest.lock');
    if (existsSync(podLock) && existsSync(manifestLock) && readFileSync(podLock).equals(readFileSync(manifestLock)))
      pass('Podfile.lock matches Pods/Manifest.lock');
    else fail('CocoaPods lock mismatch', 'run cd ios && pod install --deployment after current verification');
  }

  checkProviderSources(root);

  process.stdout.write(`Read-only LiFlow native preflight\nRoot: ${root}\n`);
  for (const item of passes) process.stdout.write(`PASS ${item}\n`);
  for (const item of failures) process.stdout.write(`FAIL ${item}\n`);
  process.stdout.write(`Summary: ${passes.length} pass, ${failures.length} fail\n`);
  if (failures.length) process.exitCode = 1;
}

try { main(); } catch (error) {
  process.stderr.write(`FAIL preflight: ${error.message}\n`);
  process.exitCode = 2;
}
