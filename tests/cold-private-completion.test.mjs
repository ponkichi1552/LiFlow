import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { pinPrivateFixtureTime } from './helpers/sharing-v2-private-fixture.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createV2DevelopmentPreview } from '../src/features/sharing/development/v2-preview-session.ts';
import { createCompletionIntents } from '../src/features/planner/completion-intents.ts';
import * as commands from '../src/features/planner/completion-command.ts';
const repository = await import('../src/platform/storage/repository.ts');

const outcomes = {
  firstTap: "first tap on a cached private chore reaches the installation's journal while the personal planner and group are restoring",
  beforeEffects: 'cached private chore accepts its first tap in the frame before passive effects',
  journalFailure: 'cached private chore rolls its check back when protected storage rejects the first tap',
  replacedHousehold: 'captured private completion cannot write to a different installation after durable intake',
};
for (const platform of ['ios', 'android']) {
  for (const [outcome, label] of Object.entries(outcomes)) test(`${platform} ${label}`, async t => {
    pinPrivateFixtureTime(t);
    const personal = createDatabase(), group = createDatabase();
    const port = handle => async () => ({ database: handle.database, close: async () => handle.connection.close() });
    const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: randomUUID, now: () => new Date(),
      openDatabase: port(group), openPrivateDatabase: port(personal) });
    const model = await preview.readModel();
    const row = model.privateOverlay.home.find(task => !task.provisional && !task.completed);
    assert.ok(row, 'a non-provisional private task must exist in the saved display');
    const record = { userId: preview.userId, groupId: preview.groupId, localGeneration: 'generation-1', status: 'active' };
    const context = { ready: true, active: null, userId: preview.userId, group: record, startupDisplay: { record, model } };
    const household = (await repository.loadPlannerSnapshot(personal.database)).household;
    const journal = new Map();
    let releaseWrite, releaseSave, finishWrite, rejectedId, applied = 0;
    const businessWrite = new Promise(resolve => { releaseWrite = resolve; });
    const secureWrite = new Promise(resolve => { releaseSave = resolve; });
    const writeResult = new Promise(resolve => { finishWrite = resolve; });
    const completions = loadNativeModule('src/platform/storage/completion-intents.ts', {
      'expo-crypto': { randomUUID },
      '../../features/planner/completion-intents.ts': { createCompletionIntents },
      '../../features/planner/completion-command.ts': commands,
      './completion-intent-store.ts': { protectedCompletionIntentStore: scope => ({
        load: async () => structuredClone(journal.get(scope) ?? []),
        save: async rows => {
          if (outcome === 'journalFailure' && !rejectedId && JSON.parse(scope)[0] === 'personal' && rows.some(value => value.status === 'queued')) {
            rejectedId = rows.find(value => value.status === 'queued').id;
            await secureWrite; throw new Error('Synthetic protected storage failure');
          }
          journal.set(scope, structuredClone(rows));
        },
      }) },
      './repository': { ...repository, setPersonalDateTaskCompletedIntent: async (...args) => {
        await businessWrite; applied++;
        try { const result = await repository.setPersonalDateTaskCompletedIntent(...args); finishWrite({ result }); return result; }
        catch (error) { finishWrite({ error }); throw error; }
      } },
      '../../features/google-sync/coordinator': { syncGoogleTasksAfterLocalCompletion() {} },
    });
    const refresh = async () => {};
    const local = { database: personal.database, snapshot: null, refresh, readError: () => null };
    const ui = screenHarness('tests/helpers/workspace-route-host.tsx', { platform, exportName: 'WorkspaceRouteHost', props: { view: 'home' },
      effectDependencies: true, focusDependencies: true, effect: callback => { if (outcome !== 'beforeEffects') return callback(); },
      layoutEffect: callback => callback(),
      mocks: { '../../../hooks/use-workspace': { useWorkspace: () => context },
        '../../../hooks/use-planner-data': { usePlannerData: () => local },
        '../../../platform/storage/completion-intents': completions,
        '../../../platform/storage/repository': repository },
    });
    try {
      await ui.flush();
      const taskCheckbox = () => ui.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel?.includes(row.chore.name));
      const checkbox = taskCheckbox();
      assert.ok(checkbox && !checkbox.props.disabled && typeof checkbox.props.onPress === 'function', 'the cached private chore must accept its first completion tap');
      void checkbox.props.onPress();
      ui.render();
      assert.equal(taskCheckbox().props.accessibilityState.checked, true, 'immediate feedback must accompany the tap');
      const scope = JSON.stringify(['personal', household.id, household.createdAt]);
      await ui.flush();
      if (outcome === 'journalFailure') {
        releaseSave(); await ui.flush();
        assert.equal(taskCheckbox().props.accessibilityState.checked, false);
        assert.match(ui.text(), /端末に保存できませんでした/u);
        assert.equal(journal.get(scope)?.length ?? 0, 0);
        assert.equal(applied, 0);
        assert.ok(!ui.nodes().some(node => node.props.accessibilityLabel === '直前の完了を元に戻す'), 'a failed save must dismiss its success toast');
        await ui.press('保存を再試行'); await ui.flush();
        assert.equal(journal.get(scope)?.[0]?.id, rejectedId, 'retry persists the same operation without an additional tap on the task');
        return;
      }
      const saved = journal.get(scope) ?? [];
      assert.equal(saved.length, 1, 'an accepted private tap must reach the protected local journal before the full planner or shared session is available');
      assert.equal(saved[0].status, 'queued');
      assert.equal(saved[0].target.command.revision, row.revision);
      assert.equal(saved[0].completed, true);
      assert.equal(applied, 0);
      if (outcome === 'replacedHousehold') {
        personal.connection.prepare('UPDATE households SET created_at=? WHERE id=?').run('2001-01-01T00:00:00.000Z', household.id);
        releaseWrite();
        const result = await writeResult; assert.match(result.error?.message ?? '', /保存先が変わりました/u);
        await ui.flush();
        assert.equal(taskCheckbox().props.accessibilityState.checked, false);
        assert.equal(personal.connection.prepare('SELECT COUNT(*) AS count FROM planner_completion_intents').get().count, 0);
        assert.equal(personal.connection.prepare("SELECT COUNT(*) AS count FROM chore_completions WHERE chore_id=? AND outcome='completed'").get(row.chore.id).count, 0);
      }
    } finally {
      ui.unmount();
      releaseSave(); releaseWrite();
      await new Promise(resolve => setImmediate(resolve));
      await preview.close();
    }
  });
}
