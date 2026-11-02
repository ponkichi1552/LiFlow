import { File } from 'expo-file-system';
import { defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertSharedIdentifier } from '../../features/sharing/operations.ts';
import { privateCalendarDatabaseFilename } from '../../features/sharing/private-calendar/database-name.ts';
import type { PrivateCalendarDatabaseConnection } from '../storage/private-calendar-store.ts';

export function validateSharingDatabaseLocation(value: unknown, defaultDirectory: string, platform: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('共有用の安全な保存先が準備されていません。');
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).sort().join(',') !== 'databaseDirectory,platform,policyVersion'
    || marker.policyVersion !== 1 || marker.platform !== platform || typeof marker.databaseDirectory !== 'string') throw new Error('共有用の保存先を確認できません。');
  const expectedRoot = decodeURIComponent(defaultDirectory.replace(/^file:\/\//u, '').replace(/\/$/u, ''));
  const expected = platform === 'ios' ? `${expectedRoot}/shared` : platform === 'android'
    ? expectedRoot.replace(/\/files\/SQLite$/u, '/no_backup/LiFlowSharedSQLite') : '';
  const normalize = (path: string) => platform === 'android' ? path.replace(/^\/data\/user\/0\//u, '/data/data/')
    : path.replace(/^\/private\/var\//u, '/var/');
  if (!expected || !expected.startsWith('/') || expected.includes('/../') || normalize(marker.databaseDirectory) !== normalize(expected)
    || (platform === 'android' && !expected.endsWith('/no_backup/LiFlowSharedSQLite'))) throw new Error('共有DBを通常のバックアップ領域へ保存できません。');
  return `file://${marker.databaseDirectory}`;
}

/** The marker is produced by native code only after backup exclusion succeeds. No fallback to personal storage. */
export async function sharingDatabaseDirectory(): Promise<string> {
  // SQLite exposes a plain absolute path on Android; FileSystem requires a file URI.
  const directoryUri = defaultDatabaseDirectory.startsWith('/') ? `file://${defaultDatabaseDirectory}` : defaultDatabaseDirectory;
  const marker = new File(directoryUri, 'shared-location.json');
  if (!marker.exists) throw new Error('共有にはLiFlowの新しいモバイルビルドが必要です。');
  return validateSharingDatabaseLocation(JSON.parse(await marker.text()), defaultDatabaseDirectory, Platform.OS);
}

export function sharingDatabaseFilename(userId: string, groupId: string, localGeneration?: string): string {
  assertSharedIdentifier(userId); assertSharedIdentifier(groupId);
  if (localGeneration) assertSharedIdentifier(localGeneration);
  return `group-${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(localGeneration ? [userId, groupId, localGeneration] : [userId, groupId]))))}.db`;
}

/** Disjoint from every v1 generation, including a user-supplied generation named "v2". */
export function sharingV2DatabaseFilename(userId: string, groupId: string, localGeneration?: string): string {
  return sharingDatabaseFilename(userId, groupId, localGeneration).replace(/^group-/u, 'group-v2-');
}

export async function sharingDatabaseFileExists(filename: string): Promise<boolean> {
  if (!/^group-[a-f0-9]{64}\.db$/u.test(filename)) throw new Error('Invalid legacy sharing database filename');
  return new File(await sharingDatabaseDirectory(), filename).exists;
}

/** The account is part of the filename: private Google mappings cannot cross Firebase accounts. */
export async function openSharingDatabase(userId: string, groupId: string, localGeneration?: string) {
  return openDatabaseAsync(sharingDatabaseFilename(userId, groupId, localGeneration), { useNewConnection: true }, await sharingDatabaseDirectory());
}

export async function openSharingV2Database(userId: string, groupId: string, localGeneration?: string) {
  return openDatabaseAsync(sharingV2DatabaseFilename(userId, groupId, localGeneration), { useNewConnection: true }, await sharingDatabaseDirectory());
}

export async function openPrivateCalendarDatabase(userId: string, development = false): Promise<PrivateCalendarDatabaseConnection> {
  if (development && !__DEV__) throw new Error('検査用の本人DBは開発ビルドだけで使用できます。');
  const filename = privateCalendarDatabaseFilename(userId, development);
  const database = await openDatabaseAsync(filename, { useNewConnection: true }, await sharingDatabaseDirectory());
  return Object.freeze({ kind: 'private-calendar', ownerUserId: userId, development, filename, database });
}
