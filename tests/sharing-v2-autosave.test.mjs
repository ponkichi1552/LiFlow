import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { createV2ConfigurationAutosave } from '../src/features/sharing/v2-ui/configuration-autosave.ts';
import { createV2ConfigurationEditorState } from '../src/features/sharing/v2-ui/configuration-editor-state.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
async function setup() {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds()); let id = 0;
  const actions = createV2PlannerActions(d.repository, { makeId: () => `autosave-${++id}`, now });
  const configuration = async () => (await actions.readPlan(range)).occurrences[0].configuration;
  return { ...d, actions, configuration, f };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test('retained shared setting drafts keep their selected effective date across failure and editor recreation', async t => {
  const d = await setup(); t.after(() => d.connection.close()); let fail = true; const dates = [];
  const save = async (edits, from) => { dates.push(from); if (fail) throw new Error('save failed'); return d.actions.patchChoreConfigurationFields('floor', edits, from); };
  const input = { configuration: await d.configuration(), effectiveFrom: '2026-10-27', save, onSaved: async () => {} };
  const editor = createV2ConfigurationEditorState(input); editor.changeEffectiveFrom('2026-12-01'); editor.changeNumber('intervalDays', '17');
  assert.equal(await editor.flush(), false);
  editor.updateInput({ ...input, effectiveFrom: '2026-10-28' });
  assert.equal(editor.getSnapshot().effectiveFrom, '2026-12-01');
  editor.changeEffectiveFrom('2026-10-28'); assert.equal(editor.getSnapshot().effectiveFrom, '2026-12-01');
  fail = false; assert.equal(await editor.flush(), true); assert.deepEqual(dates, ['2026-12-01', '2026-12-01']);
  const facts = await (await import('../src/platform/storage/sharing-ledger.ts')).loadSharedFacts(d.database, groupId);
  assert.equal(facts.find(row => row.operation.entityType === 'chorePolicy' && row.operation.payload.configuration?.intervalDays === 17).operation.payload.configuration.effectiveFrom, '2026-12-01');
});

test('v2 autosave batches valid fields into one revision and does not change another field after its base became stale during a save', async () => {
  const d = await setup();
  try {
    const entered = deferred(); const release = deferred(); let first = true; let autosave;
    autosave = createV2ConfigurationAutosave({ configuration: await d.configuration(), effectiveFrom: () => '2026-10-27', delayMs: 60000,
      save: async (edits, from) => { if (first) { first = false; entered.resolve(); await release.promise; } return d.actions.patchChoreConfigurationFields('floor', edits, from); },
      onSaved: async () => autosave.updateDisplayed(await d.configuration()) });
    autosave.enqueue('intervalDays', 3); const running = autosave.flush(); await entered.promise;
    await d.actions.patchChoreConfiguration('floor', 1, { windowAfterDays: 4 }, '2026-10-27');
    autosave.enqueue('windowAfterDays', 5); release.resolve(); assert.equal(await running, false);
    const cfg = await d.configuration(); assert.equal(cfg.intervalDays, 3); assert.equal(cfg.windowAfterDays, 4); assert.equal(cfg.ruleVersion, 3);
    assert.equal(autosave.getSnapshot().phase, 'error'); assert.equal(autosave.isDirty('windowAfterDays'), true);
    autosave.discard('windowAfterDays'); autosave.updateDisplayed(cfg); assert.equal(await autosave.flush(), true);
  } finally { d.connection.close(); }
});
test('v2 autosave advances only its own field bases so typing during an in-flight save remains a sequential local edit', async () => {
  const d = await setup();
  try {
    const entered = deferred(); const release = deferred(); let first = true; let autosave;
    autosave = createV2ConfigurationAutosave({ configuration: await d.configuration(), effectiveFrom: () => '2026-10-27', delayMs: 60000,
      save: async (edits, from) => { if (first) { first = false; entered.resolve(); await release.promise; } return d.actions.patchChoreConfigurationFields('floor', edits, from); },
      onSaved: async () => autosave.updateDisplayed(await d.configuration()) });
    autosave.enqueue('intervalDays', 3); const running = autosave.flush(); await entered.promise;
    autosave.enqueue('intervalDays', 4); release.resolve(); assert.equal(await running, true);
    const cfg = await d.configuration(); assert.equal(cfg.intervalDays, 4); assert.equal(cfg.ruleVersion, 3); assert.equal(autosave.isDirty('intervalDays'), false);
  } finally { d.connection.close(); }
});
test('v2 autosave removes invalid pending numeric text without resurrecting it and coalesces separate valid fields', async () => {
  const d = await setup();
  try {
    const autosave = createV2ConfigurationAutosave({ configuration: await d.configuration(), effectiveFrom: () => '2026-10-27', delayMs: 60000,
      save: (edits, from) => d.actions.patchChoreConfigurationFields('floor', edits, from) });
    autosave.enqueue('intervalDays', 1); autosave.invalidate('intervalDays'); assert.equal(await autosave.flush(), true);
    assert.equal((await d.configuration()).intervalDays, 7);
    autosave.enqueue('intervalDays', 17); autosave.enqueue('windowAfterDays', 4); assert.equal(await autosave.flush(), true);
    const cfg = await d.configuration(); assert.equal(cfg.intervalDays, 17); assert.equal(cfg.windowAfterDays, 4); assert.equal(cfg.ruleVersion, 2);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 6);
  } finally { d.connection.close(); }
});
test('v2 autosave does not replay an already committed setting when only the screen refresh fails', async () => {
  const d = await setup();
  try {
    let refreshErrors = 0;
    const autosave = createV2ConfigurationAutosave({ configuration: await d.configuration(), effectiveFrom: () => '2026-10-27', delayMs: 60000,
      save: (edits, from) => d.actions.patchChoreConfigurationFields('floor', edits, from), onSaved: async () => { throw new Error('view refresh failed'); }, onRefreshError: () => { refreshErrors++; } });
    autosave.enqueue('windowAfterDays', 3); assert.equal(await autosave.flush(), true); assert.equal(autosave.getSnapshot().phase, 'saved');
    assert.equal(refreshErrors, 1); assert.equal((await d.configuration()).ruleVersion, 2); assert.equal(await autosave.flush(), true);
    assert.equal((await d.configuration()).ruleVersion, 2);
  } finally { d.connection.close(); }
});

test('v2 editor remote refresh preserves dirty text, updates untouched fields and refuses stale refreshes without advancing the draft base', async () => {
  const d = await setup();
  try {
    const initial = await d.configuration(); const makeInput = (configuration) => ({ configuration, effectiveFrom: '2026-10-27',
      save: (edits, from) => d.actions.patchChoreConfigurationFields('floor', edits, from), onSaved: async () => {} });
    const editor = createV2ConfigurationEditorState(makeInput(initial)); editor.changeNumber('intervalDays', '');
    await d.actions.patchChoreConfiguration('floor', 1, { intervalDays: 4, windowAfterDays: 5 }, '2026-10-27');
    const remote = await d.configuration(); editor.updateInput(makeInput(remote));
    assert.equal(editor.getSnapshot().draft.intervalDays, ''); assert.equal(editor.getSnapshot().draft.windowAfterDays, '5');
    editor.updateInput(makeInput(initial)); assert.equal(editor.getSnapshot().draft.windowAfterDays, '5');
    editor.changeNumber('intervalDays', '17'); assert.equal(await editor.flush(), false);
    assert.equal((await d.configuration()).intervalDays, 4); assert.equal(editor.getSnapshot().status.phase, 'error');
    editor.discard(); assert.equal(editor.getSnapshot().draft.intervalDays, '4'); assert.equal(editor.hasDraft(), false);
    editor.changeNumber('intervalDays', '17'); assert.equal(await editor.flush(), true); assert.equal((await d.configuration()).intervalDays, 17);
  } finally { d.connection.close(); }
});

test('v2 editor removal remains blocked throughout an in-flight save and repeated back requests cannot navigate twice', async () => {
  const d = await setup();
  try {
    const entered = deferred(); const release = deferred(); let navigated = 0;
    const editor = createV2ConfigurationEditorState({ configuration: await d.configuration(), effectiveFrom: '2026-10-27',
      save: async (edits, from) => { entered.resolve(); await release.promise; return d.actions.patchChoreConfigurationFields('floor', edits, from); }, onSaved: async () => {} });
    editor.changeNumber('intervalDays', '17'); const leaving = editor.navigateAfterSave(() => { navigated++; }); await entered.promise;
    assert.equal(editor.getSnapshot().leaving, true); assert.equal(editor.getSnapshot().removalAllowed, false);
    assert.equal(await editor.navigateAfterSave(() => { navigated++; }), false); release.resolve(); assert.equal(await leaving, true);
    assert.equal(navigated, 1); assert.equal(editor.getSnapshot().removalAllowed, true); assert.equal((await d.configuration()).intervalDays, 17);
    editor.resumeNavigation(); assert.equal(editor.getSnapshot().removalAllowed, false); assert.equal(editor.getSnapshot().leaving, false);
  } finally { d.connection.close(); }
});

test('v2 editor failed or invalid drafts prevent leaving and remain retryable instead of being lost on navigation', async () => {
  const d = await setup();
  try {
    let fail = true; let navigated = 0;
    const editor = createV2ConfigurationEditorState({ configuration: await d.configuration(), effectiveFrom: '2026-10-27',
      save: (edits, from) => { if (fail) throw new Error('SQLite full'); return d.actions.patchChoreConfigurationFields('floor', edits, from); }, onSaved: async () => {} });
    editor.changeNumber('intervalDays', '17'); assert.equal(await editor.navigateAfterSave(() => { navigated++; }), false);
    assert.equal(editor.getSnapshot().draft.intervalDays, '17'); assert.equal(editor.getSnapshot().removalAllowed, false); assert.equal(navigated, 0);
    fail = false; assert.equal(await editor.navigateAfterSave(() => { navigated++; }), true); assert.equal(navigated, 1);
    editor.resumeNavigation(); editor.changeNumber('intervalDays', '');
    assert.equal(await editor.navigateAfterSave(() => { navigated++; }), false); assert.equal(navigated, 1);
    assert.equal(editor.getSnapshot().draft.intervalDays, ''); editor.discard();
  } finally { d.connection.close(); }
});
