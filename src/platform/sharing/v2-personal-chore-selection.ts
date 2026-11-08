import { openDatabaseAsync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { readPersonalChoreCopySource } from '../storage/repository';
import type { SharedWorkspace } from './workspace-types';
import { prepareV2PersonalCopy, v2PersonalCopyDrafts } from '../../features/sharing/v2/personal-copy';
import { v2ReadPoint } from '../../features/sharing/v2/view-point';
import { sharedRosterDigest } from '../../features/sharing/roster';
import { matchingSharedChores, sharedPersonalChoiceId } from '../../features/settings/group-personal-chore-choices';

/** The checkbox is the sharing action. Merely opening settings reads definitions locally, without schedules or history. */
export function createNativeV2PersonalChoreSelection(workspace: Extract<SharedWorkspace, { protocol: 2 }>, assertAccess: () => Promise<void>) {
  const { userId, groupId } = workspace;
  const guard = async () => {
    const scope = workspace.session.repository.scope;
    if (scope.userId !== userId || scope.groupId !== groupId) throw new Error('共有家事の設定先と管理者を確認してください。');
    await assertAccess();
  };
  async function read(ids?: readonly string[]) {
    await guard();
    const database = await openDatabaseAsync('housework.db', { useNewConnection: true });
    try {
      await guard(); const source = await readPersonalChoreCopySource(database, ids); await guard();
      if (source.householdId !== 'local-household' || source.chores.some(chore => chore.householdId !== source.householdId)) throw new Error('本人の家事を読み直してください。');
      return { ...source, scope: 'personal' as const, ownerUserId: userId };
    } finally { await database.closeAsync(); }
  }
  return { read: async () => (await read()).chores,
    async add(personalChoreId: string, enabled: boolean) {
      const source = await read([personalChoreId]);
      const chore = source.chores.find(row => row.id === personalChoreId && !row.archived);
      if (!chore) throw new Error('追加する家事を読み直してください。');
      if (enabled && chore.requiresCycleSelection) throw new Error('家事名をタップして、周期を設定してください。');
      let choreId = sharedPersonalChoiceId(userId, groupId, personalChoreId); let created = false;
      await workspace.session.repository.commitCurrent(async state => {
        await guard(); const roster = state.archive.at(-1)!;
        if (roster.body.ownerUserId !== userId) throw new Error('共有家事の設定は管理者が変更できます。');
        const view = state.assessment.view; const at = v2ReadPoint(view, roster);
        const definitions = [...new Set(view.ofType('chore').map(row => row.entityId))].filter(id =>
          view.field('chore', id, '$alive', at)?.value === true).map(id => ({ id,
          name: String(view.field('chore', id, 'name', at)?.value ?? ''), category: String(view.field('chore', id, 'category', at)?.value ?? '') }));
        const matches = matchingSharedChores(chore, definitions);
        const exact = definitions.find(row => row.id === choreId);
        if (!exact && matches.length > 1) throw new Error('同じ名前の共有家事が複数あります。グループの一覧から選んでください。');
        const existing = exact ?? matches[0];
        if (existing) {
          if (view.field('chore', existing.id, 'archived', at)?.value === true) throw new Error('この家事はグループで削除されています。');
          choreId = existing.id; return [];
        }
        if (view.topic('chore', choreId).length) throw new Error('この家事はグループで削除されています。');
        // The group-bound opaque ID makes retries safe; the personal ID is never signed or uploaded.
        let first = true;
        const review = prepareV2PersonalCopy({ ...source, chores: [{ ...chore, enabled }] }, {
          userId, groupId, administratorUserId: roster.body.ownerUserId, rosterDigest: sharedRosterDigest(roster),
          groupName: String(view.field('settings', 'settings', 'name', at)?.value ?? ''),
          timeZone: String(view.field('settings', 'settings', 'timeZone', at)?.value ?? ''),
        }, [personalChoreId], 'common', () => { if (first) { first = false; return choreId; } return randomUUID(); }, new Date());
        created = true; await guard(); return v2PersonalCopyDrafts(review);
      });
      await guard();
      if (!created && enabled) await workspace.session.controller.actions.patchChore(choreId, { enabled: true });
      return choreId;
    },
  };
}
