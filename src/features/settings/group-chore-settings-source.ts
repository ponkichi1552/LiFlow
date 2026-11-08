import { createPlannerRefreshController } from '../planner/refresh-controller.ts';
import type { SharedWorkspace } from '../../platform/sharing/workspace-types';
import type { SharingSelection } from '../sharing/workspace-selection';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry';
import { createV2ScreenSession } from '../sharing/v2-ui/screen-session.ts';
import type { V2GroupScreenModel } from '../sharing/v2/controller';
import { validateChoreToggle } from '../../domain/chores/chore-groups.ts';
import type { ChoreDefinition } from '../../domain/chores/types';
import { availablePersonalChoreChoices, personalChoiceSourceId } from './group-personal-chore-choices.ts';
import type { V2MutationOutcome } from '../sharing/v2-ui/mutation-outcome';

export type GroupChoreSettingsValue = { workspace: Extract<SharedWorkspace, { protocol: 2 }>; record: SharingWorkspaceRecord; protocol: 2; model: V2GroupScreenModel; personalChoices?: ChoreDefinition[]; personalChoicesError?: string };
type PersonalSelection = (workspace: Extract<SharedWorkspace, { protocol: 2 }>, assertAccess: () => Promise<void>) => {
  read(): Promise<readonly ChoreDefinition[]>; add(id: string, enabled: boolean): Promise<string>;
};

/** Reads a named group without selecting it or starting another planner/Google/background worker. */
export function createGroupChoreSettingsSource(selection: SharingSelection, open: (selection: SharingSelection) => Promise<SharedWorkspace>, prepared?: {
  readModel: () => Promise<V2GroupScreenModel>; invalidate: () => void;
}, personalSelection?: PersonalSelection, includeWaste = false) {
  let generation: string | undefined; let generationCaptured = false;
  const authorize = async () => {
    const workspace = await open(selection);
    if (workspace.userId !== selection.userId || workspace.groupId !== selection.groupId || workspace.protocol !== 2) throw new Error('共有グループを確認してください。');
    const record = await workspace.record();
    if (record.userId !== selection.userId || record.groupId !== selection.groupId || !['active', 'creating'].includes(record.status)
      || (generationCaptured && generation !== record.localGeneration)) throw new Error('グループの参加状態が変わりました。設定を開き直してください。');
    generation = record.localGeneration; generationCaptured = true;
    return { workspace, record };
  };
  const controller = createPlannerRefreshController<GroupChoreSettingsValue>({
    discardSnapshotOnError: () => true,
    load: async () => {
      const { workspace, record } = await authorize();
      const value: GroupChoreSettingsValue = { workspace, record, protocol: 2, model: prepared ? await prepared.readModel() : await createV2SettingsSession(workspace).readModel({ management: true, ...(includeWaste ? { waste: true } : {}) }) };
      if (personalSelection && value.model.viewerUserId === value.model.adminUserId) {
        try {
          const personal = personalSelection(workspace, async () => { await authorize(); });
          value.personalChoices = availablePersonalChoreChoices(selection.userId, selection.groupId, await personal.read(), value.model.plan.chores);
        } catch { value.personalChoicesError = '個人から追加できる家事を読み込めませんでした。'; }
      }
      await authorize();
      return { snapshot: value, canPublishWidget: false };
    },
    weather: async () => null, publish: () => {},
  });
  const addPersonalChore = async (choiceId: string, enabled: boolean) => {
    const id = personalChoiceSourceId(choiceId);
    if (!id || !personalSelection) throw new Error('追加する家事を選び直してください。');
    const { workspace } = await authorize();
    const sharedId = await personalSelection(workspace, async () => { await authorize(); }).add(id, enabled);
    prepared?.invalidate(); await controller.refresh(); await authorize();
    return { id: sharedId, refreshed: !controller.getSnapshot().error };
  };
  return { ...controller,
    addPersonalChore,
    async perform(work: () => Promise<unknown>): Promise<V2MutationOutcome> {
      let committed = false;
      try {
        await authorize(); await work(); committed = true;
        prepared?.invalidate(); await controller.refresh(); await authorize();
        const error = controller.getSnapshot().error;
        return { committed, refreshed: !error, ...(error ? { error: new Error(error) } : {}) };
      } catch (error) { return { committed, refreshed: false, error }; }
    },
    async resetSchedules() {
      const { workspace } = await authorize();
      const session = createV2SettingsSession(workspace); const model = await session.readModel({ choreSettings: true });
      const chores = model.plan.chores.filter(chore => !chore.archived);
      await workspace.session.controller.actions.resetChoreSchedules(chores.map(chore => chore.id),
        Object.fromEntries(chores.map(chore => [chore.id, model.configurations.find(row => row.choreId === chore.id)?.configuration?.ruleVersion])));
      prepared?.invalidate(); await controller.refresh();
      if (controller.getSnapshot().error) throw new Error('端末に保存済みですが、表示を更新できませんでした。開き直して確認してください。');
    },
    async saveEnabled(ids: string[], enabled: boolean) {
      validateChoreToggle(ids, enabled);
      const { workspace } = await authorize();
      // A category tap must never create partial shared writes.
      if (ids.length !== 1) throw new Error('共有家事は一件ずつ切り替えてください。');
      if (workspace.roster()?.body.ownerUserId !== selection.userId) throw new Error('有効・無効はグループの管理者が変更できます。');
      if (personalChoiceSourceId(ids[0])) return addPersonalChore(ids[0], enabled);
      await workspace.session.controller.actions.patchChore(ids[0], { enabled });
      prepared?.invalidate();
      await controller.refresh();
      return { refreshed: !controller.getSnapshot().error };
    },
  };
}

/** Management must not read personal availability, Google tokens, or overlay/history data. */
export function createV2SettingsSession(workspace: Extract<SharedWorkspace, { protocol: 2 }>) {
  const session = createV2ScreenSession({ controller: { ...workspace.session.controller, sync: () => workspace.sync({ force: true }) },
    groupId: workspace.groupId, userId: workspace.userId, now: () => new Date(),
    readPreferences: () => { throw new Error('家事設定では個人の時間帯を読み取りません。'); } });
  return { ...session, readModel: (options?: Parameters<typeof session.readModel>[0]) => session.readModel({ ...options, management: true }) };
}
