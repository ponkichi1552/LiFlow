import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaveForm } from '../src/features/settings/autosave-form.ts';
const setup = save => createAutosaveForm({ initial: { n: 1 }, draft: value => ({ ...value }), clone: value => ({ ...value }),
  normalize: value => ({ ...value }), save, delayMs: 60_000 });

test('discard during an already running autosave follows its committed value instead of showing an unsaved old value', async () => {
  let finish;
  const form = setup(value => new Promise(resolve => { finish = () => resolve(value); }));
  form.change(() => ({ n: 2 })); const pending = form.flush(); form.discardDraft(); finish(); await pending;
  assert.equal(form.getSnapshot().raw.n, 2); assert.equal(form.getSnapshot().hasDraft, false);
});

test('reversing an edit before debounce does not write unchanged settings or trigger downstream recalculation', async () => {
  let writes = 0; const form = setup(async value => { writes++; return value; });
  form.change(() => ({ n: 2 })); form.change(() => ({ n: 1 }));
  assert.equal(await form.flush(), true); assert.equal(writes, 0);
});

test('reversing an edit while a different value is already saving still persists the reversal', async () => {
  const writes = []; let finish;
  const form = setup(async value => { writes.push(value.n); if (writes.length === 1) await new Promise(resolve => { finish = resolve; }); return value; });
  form.change(() => ({ n: 2 })); const pending = form.flush(); form.change(() => ({ n: 1 })); finish(); await pending;
  assert.deepEqual(writes, [2, 1]); assert.equal(form.getSnapshot().raw.n, 1);
});

test('an immediate edit queued in a saved observer microtask is not stranded behind the completed writer', async () => {
  const { createAutosaveQueue } = await import('../src/features/settings/autosave-queue.ts');
  const writes = []; let updated = false;
  const queue = createAutosaveQueue({ save: async patch => { writes.push(patch.n); }, delayMs: 60_000 });
  queue.subscribe(() => { if (queue.getSnapshot().phase === 'saved' && !updated) { updated = true; queueMicrotask(() => queue.enqueue({ n: 2 }, true)); } });
  queue.enqueue({ n: 1 }); await queue.flush();
  for (let n = 0; n < 12; n++) await Promise.resolve();
  assert.deepEqual(writes, [1, 2]); assert.equal(queue.getSnapshot().phase, 'saved');
});

test('chore settings back navigation discards invalid numeric input without changing saved values', async () => {
  const { screenHarness } = await import('./helpers/screen-harness.mjs');
  const calls = [];
  const chore = { id: 'chore', householdId: 'local-household', name: '掃除', enabled: true, load: 'normal', windowRadiusDays: 2,
    frequencyDaysByMode: { balanced: 7 }, instructions: [], tools: [], cautions: [] };
  const snapshot = { chores: [chore], settings: { frequencyMode: 'balanced' }, states: [], completions: [] };
  const screen = screenHarness('src/app/chores/[id].tsx', { snapshot: () => snapshot, database: {}, params: { id: chore.id }, navigate: (...args) => calls.push(args),
    mocks: { '@/platform/storage/repository': { updateChoreSettings: async () => false } } });
  try {
    await screen.change('実施期間の日数幅', 'x'); await screen.press('前の画面に戻る');
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'back');
    assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '実施期間の日数幅').props.value, '2');
    assert.equal(snapshot.chores[0].windowRadiusDays, 2);
  } finally { screen.unmount(); }
});

test('a settled chore document follows a new global mode while retaining unsaved drafts during external changes', async () => {
  const { createChoreSettingsDocument } = await import('../src/features/settings/chore-settings-editor.ts');
  const chore = { id: 'chore', enabled: true, load: 'normal', windowRadiusDays: 2, frequencyDaysByMode: { balanced: 7, relaxed: 14 } };
  const doc = createChoreSettingsDocument({}); const save = async () => {};
  const first = doc.get(chore, 'balanced', save); assert.equal(first.getSnapshot().draft.cycleText, '7');
  const changed = doc.get(chore, 'relaxed', save); assert.equal(changed.getSnapshot().draft.cycleText, '14');
  changed.changeRadius('x');
  assert.equal(doc.get({ ...chore, load: 'heavy' }, 'relaxed', save), changed); assert.equal(changed.getSnapshot().draft.radiusText, 'x');
  changed.changeRadius('3'); await changed.flush();
  const refreshed = doc.get({ ...chore, windowRadiusDays: 3, load: 'heavy' }, 'balanced', save);
  assert.equal(refreshed.getSnapshot().draft.load, 'heavy'); assert.equal(refreshed.getSnapshot().draft.radiusText, '3');
});


test('audit100 a settled settings document follows external enable and load edits without losing a pending draft', async () => {
  const { createChoreSettingsDocument } = await import('../src/features/settings/chore-settings-editor.ts');
  const chore = { id: 'remote-chore', enabled: true, load: 'normal', windowRadiusDays: 2, holidayPriority: false,
    frequencyDaysByMode: { balanced: 7 } };
  const doc = createChoreSettingsDocument({}); const save = async () => {};
  const first = doc.get(chore, 'balanced', save);
  const external = { ...chore, enabled: false, load: 'heavy', windowRadiusDays: 4 };
  const refreshed = doc.get(external, 'balanced', save);
  assert.equal(refreshed.getSnapshot().draft.enabled, false);
  assert.equal(refreshed.getSnapshot().draft.load, 'heavy');
  assert.equal(refreshed.getSnapshot().draft.radiusText, '4');
  refreshed.changeRadius('invalid');
  assert.equal(doc.get({ ...external, load: 'light' }, 'balanced', save), refreshed);
  assert.equal(refreshed.getSnapshot().draft.radiusText, 'invalid');
  assert.notEqual(first, refreshed);
});
