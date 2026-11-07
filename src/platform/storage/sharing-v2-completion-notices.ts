import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from './sharing-v2-events';
import { buildV2CommonPlan } from '../../features/sharing/v2/common-plan.ts';
import { v2ReadPoint } from '../../features/sharing/v2/view-point.ts';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { v2CompletionNoticeCandidates } from '../../features/sharing/v2/completion-notices.ts';
import type { GroupPolicy } from '../../features/sharing/v2/model';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';

type Repository = ReturnType<typeof createV2EventRepository>;
type State = Awaited<ReturnType<Repository['readState']>>;
export interface V2CompletionNoticeBatch { revision: string; keys: string[]; names: string[]; issueToken?: string }
let batchSequence = 0;
/** Queue until the OS request boundary; only an issued/uncertain request is at-most-once. */
export function createV2CompletionNoticeStore(input: { repository: Repository; userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  const { repository, userId, groupId } = input;
  if (repository.scope.userId !== userId || repository.scope.groupId !== groupId) throw new Error('完了通知の保存先を確認してください。');
  const enabled = (state: State) => {
    const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
    try { return (state.assessment.view.field('groupPolicy', 'policy', 'configuration', at)?.value as unknown as GroupPolicy)?.completionPushEnabled === true; }
    catch { return false; }
  };
  async function initialize(transaction: SQLiteDatabase) {
    await input.assertAccess();
    const row = await transaction.getFirstAsync<{ user_id: string; group_id: string; schema_version: number }>('SELECT user_id,group_id,schema_version FROM sharing_v2_binding WHERE singleton=1');
    if (row?.user_id !== userId || row.group_id !== groupId || row.schema_version !== 2) throw new Error('完了通知の保存先が変わりました。');
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_private_notice_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), was_enabled INTEGER NOT NULL CHECK(was_enabled IN (0,1)));
      CREATE TABLE IF NOT EXISTS sharing_v2_private_notice_seen(subject_key TEXT PRIMARY KEY, claimed INTEGER NOT NULL CHECK(claimed IN (0,1)));
      CREATE TABLE IF NOT EXISTS sharing_v2_private_notice_pending(subject_key TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sharing_v2_private_notice_issued(subject_key TEXT PRIMARY KEY, issue_token TEXT NOT NULL);`);
    await input.assertAccess();
  }
  async function paused(transaction: SQLiteDatabase) {
    await transaction.runAsync('DELETE FROM sharing_v2_private_notice_pending');
    await transaction.runAsync('INSERT INTO sharing_v2_private_notice_state VALUES(1,0) ON CONFLICT(singleton) DO UPDATE SET was_enabled=0 WHERE was_enabled!=0');
    await input.assertAccess();
  }
  return {
    scope: Object.freeze({ userId, groupId }),
    enabled: () => repository.readCurrent(async (state, transaction) => {
      await initialize(transaction); const allowed = enabled(state); if (!allowed) await paused(transaction); return allowed;
    }),
    collect(permitted: boolean, now: Date, assertCurrent: () => void | Promise<void> = input.assertAccess): Promise<V2CompletionNoticeBatch | null> {
      const instant = new Date(now); if (typeof permitted !== 'boolean' || !Number.isFinite(instant.getTime())) return Promise.reject(new Error('完了通知の時刻と許可を確認してください。'));
      return repository.readCurrent(async (state, transaction) => {
        await initialize(transaction);
        if (!permitted || !enabled(state)) { await paused(transaction); return null; }
        const roster = state.archive.at(-1)!; const at = v2ReadPoint(state.assessment.view, roster);
        const zone = state.assessment.view.field('settings', 'settings', 'timeZone', at)?.value;
        if (typeof zone !== 'string') throw new Error('完了通知の地域を確認してください。');
        const today = sharedLocalDate(instant, zone); const plan = buildV2CommonPlan(state, { from: today, through: today, asOfDate: today });
        const candidates = v2CompletionNoticeCandidates(plan, userId, roster.body.ownerUserId);
        const prior = await transaction.getFirstAsync<{ was_enabled: number }>('SELECT was_enabled FROM sharing_v2_private_notice_state WHERE singleton=1');
        if (prior && ![0, 1].includes(prior.was_enabled)) throw new Error('完了通知の確認状態を読み直してください。');
        if (await transaction.getFirstAsync(`SELECT 1 FROM sharing_v2_private_notice_seen WHERE length(subject_key)<>64 OR subject_key GLOB '*[^a-f0-9]*' OR claimed NOT IN (0,1) LIMIT 1`)) throw new Error('完了通知の確認記録を読み直してください。');
        const seen: { subject_key: string }[] = [];
        for (let offset = 0; offset < candidates.length; offset += 100) { const page = candidates.slice(offset, offset+100);
          seen.push(...await transaction.getAllAsync<{ subject_key: string }>(`SELECT subject_key FROM sharing_v2_private_notice_seen WHERE subject_key IN (${page.map(() => '?').join(',')})`, ...page.map(row => row.key))); }
        const known = new Set(seen.map(row => row.subject_key)); const fresh = candidates.filter(row => !known.has(row.key));
        const notify = (row: typeof fresh[number]) => prior?.was_enabled === 1 && row.notify;
        for (let offset = 0; offset < fresh.length; offset += 100) {
          await input.assertAccess(); await assertCurrent(); const page = fresh.slice(offset, offset + 100);
          await transaction.runAsync(`INSERT INTO sharing_v2_private_notice_seen VALUES ${page.map(() => '(?,?)').join(',')}`, ...page.flatMap(row => [row.key, 0]));
          const pending = page.filter(notify); if (pending.length) await transaction.runAsync(`INSERT INTO sharing_v2_private_notice_pending VALUES ${pending.map(() => '(?,?)').join(',')}`, ...pending.flatMap(row => [row.key,row.name]));
        }
        const valid = new Map(candidates.filter(row => row.notify).map(row => [row.key,row]));
        const pending = await transaction.getAllAsync<{ subject_key: string; name: string }>('SELECT subject_key,name FROM sharing_v2_private_notice_pending ORDER BY subject_key');
        const notices = pending.flatMap(row => valid.has(row.subject_key) ? [valid.get(row.subject_key)!] : []);
        if (pending.some(row => !valid.has(row.subject_key))) await transaction.runAsync(
          'DELETE FROM sharing_v2_private_notice_pending WHERE subject_key NOT IN (SELECT value FROM json_each(?))', JSON.stringify([...valid.keys()]));
        const keys = notices.map(row => row.key); const names = notices.map(row => row.name);
        await transaction.runAsync('INSERT INTO sharing_v2_private_notice_state VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET was_enabled=1');
        const projection = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
        await input.assertAccess(); if (!keys.length) return null;
        if (!projection || !/^[a-f0-9]{64}$/u.test(projection.fact_hash)) throw new Error('完了通知の共有状態を確認してください。');
        return { revision: projection.fact_hash, keys, names,
          issueToken: sharedDocumentDigest([userId,groupId,projection.fact_hash,Date.now(),++batchSequence,Math.random()]) };
      });
    },
    current: (batch: V2CompletionNoticeBatch) => repository.readCurrent(async (state, transaction) => {
      await initialize(transaction); const projection = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
      return enabled(state) && projection?.fact_hash === batch.revision;
    }),
    issue: (batch: V2CompletionNoticeBatch, assertCurrent: () => Promise<void>) => repository.readCurrent(async (state, tx) => {
      await initialize(tx); await assertCurrent();
      if (!batch.issueToken || !/^[a-f0-9]{64}$/.test(batch.issueToken)) throw new Error('通知の受付位置を確認してください。');
      const projection = await tx.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
      if (!enabled(state) || projection?.fact_hash !== batch.revision) return false;
      for (let offset=0; offset<batch.keys.length; offset+=100) { const keys=batch.keys.slice(offset,offset+100); const placeholders=keys.map(()=>'?').join(',');
        const rows=await tx.getAllAsync<{ subject_key: string }>(`SELECT subject_key FROM sharing_v2_private_notice_pending WHERE subject_key IN (${placeholders})`,...keys);
        if (rows.length!==keys.length) return false;
      }
      for (let offset=0; offset<batch.keys.length; offset+=100) { const keys=batch.keys.slice(offset,offset+100); const placeholders=keys.map(()=>'?').join(',');
        await assertCurrent();
        await tx.runAsync(`UPDATE sharing_v2_private_notice_seen SET claimed=1 WHERE subject_key IN (${placeholders})`,...keys);
        await tx.runAsync(`INSERT OR REPLACE INTO sharing_v2_private_notice_issued VALUES${keys.map(()=>'(?,?)').join(',')}`,...keys.flatMap(key=>[key,batch.issueToken!]));
        await tx.runAsync(`DELETE FROM sharing_v2_private_notice_pending WHERE subject_key IN (${placeholders})`,...keys);
      }
      await assertCurrent(); return true;
    }),
    notIssued: (batch: V2CompletionNoticeBatch) => repository.readCurrent(async (_state,tx) => {
      await initialize(tx);
      const names = new Map(batch.keys.map((key,index)=>[key,batch.names[index]]));
      for (let offset=0;offset<batch.keys.length;offset+=100) {
        await input.assertAccess(); const keys=batch.keys.slice(offset,offset+100);
        const rows=await tx.getAllAsync<{subject_key:string}>(`SELECT subject_key FROM sharing_v2_private_notice_issued WHERE issue_token=? AND subject_key IN (${keys.map(()=>'?').join(',')})`,batch.issueToken!,...keys);
        if (!rows.length) continue;
        await tx.runAsync(`UPDATE sharing_v2_private_notice_seen SET claimed=0 WHERE subject_key IN (${rows.map(()=>'?').join(',')})`,...rows.map(row=>row.subject_key));
        await tx.runAsync(`INSERT OR IGNORE INTO sharing_v2_private_notice_pending VALUES${rows.map(()=>'(?,?)').join(',')}`,...rows.flatMap(row=>[row.subject_key,names.get(row.subject_key)!]));
      }
    }),
    settled: (batch: V2CompletionNoticeBatch) => repository.readCurrent(async (_state,tx) => {
      await initialize(tx); await tx.runAsync('DELETE FROM sharing_v2_private_notice_issued WHERE issue_token=?',batch.issueToken!);
    }),
  };
}
export type V2CompletionNoticeStore = ReturnType<typeof createV2CompletionNoticeStore>;
