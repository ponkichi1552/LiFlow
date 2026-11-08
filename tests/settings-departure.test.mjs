import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutosaveForm } from '../src/features/settings/autosave-form.ts';
import { createAutosaveQueue } from '../src/features/settings/autosave-queue.ts';
import { createChoreSettingsEditor } from '../src/features/settings/chore-settings-editor.ts';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function form(save) {
  return createAutosaveForm({ initial: { number: 7 }, delayMs: 60_000, draft: v => ({ text: String(v.number) }), clone: v => ({ ...v }),
    normalize: v => { if (!/^\d+$/u.test(v.text)) throw new Error('invalid'); return { number: Number(v.text) }; }, save });
}

test('settings departure navigates before a slow valid save and still commits that edit once', async () => {
  const gate = deferred(); let writes = 0; let saved = { number: 7 }; let backs = 0;
  const store = form(async value => { writes++; await gate.promise; saved = value; return value; });
  store.change(() => ({ text: '17' }));
  const leaving = store.navigateAfterSave(() => backs++);
  assert.equal(backs, 1); assert.equal(saved.number, 7); assert.equal(await leaving, true);
  assert.equal(await store.navigateAfterSave(() => backs++), false);
  gate.resolve(); await store.flush(); assert.equal(saved.number, 17); assert.equal(writes, 1);
});

test('settings departure discards invalid or failed input without saving or blocking navigation', async () => {
  let attempts = 0; let fail = true; let backs = 0;
  const store = form(async value => { attempts++; if (fail) throw new Error('full'); return value; });
  store.change(() => ({ text: 'invalid' }));
  assert.equal(await store.navigateAfterSave(() => backs++), true); assert.equal(store.getSnapshot().raw.text, '7');
  assert.equal(attempts, 0); assert.equal(store.getSnapshot().hasDraft, false);
  store.resumeNavigation(); store.change(() => ({ text: '17' })); assert.equal(await store.flush(), false);
  assert.equal(await store.navigateAfterSave(() => backs++), true); assert.equal(backs, 2);
  fail = false; await store.flush(); assert.equal(attempts, 1); assert.equal(store.getSnapshot().raw.text, '7');
});

test('a save failing after departure is discarded and never retried by later cleanup', async () => {
  const gate = deferred(); let attempts = 0; let backs = 0;
  const store = form(async () => { attempts++; await gate.promise; throw new Error('full'); });
  store.change(() => ({ text: '17' })); await store.navigateAfterSave(() => backs++);
  assert.equal(backs, 1); gate.resolve(); await store.flush(); await Promise.resolve();
  assert.equal(store.getSnapshot().hasDraft, false); assert.equal(store.getSnapshot().raw.text, '7');
  await store.flush(); assert.equal(attempts, 1);
});

test('discarding a departing queue prevents an in-flight failure from resurrecting old changes', async () => {
  const gate = deferred(); const writes = [];
  const queue = createAutosaveQueue({ delayMs: 60_000, save: async value => { writes.push(value); await gate.promise; throw new Error('full'); } });
  queue.enqueue({ first: 1 }, true); queue.enqueue({ second: 2 }); queue.discard(); gate.resolve(); await queue.flush();
  await queue.flush(); assert.deepEqual(writes, [{ first: 1 }]); assert.equal(queue.getSnapshot().phase, 'idle');
});

test('a discarded settings form follows an already committed save without reviving invalid input', async () => {
  const gate = deferred(); const store = form(async value => { await gate.promise; return value; });
  store.change(() => ({ text: '17' })); const saving = store.flush(); store.change(() => ({ text: 'invalid' }));
  await store.navigateAfterSave(() => {}); assert.equal(store.getSnapshot().raw.text, '7');
  gate.resolve(); await saving; assert.equal(store.getSnapshot().raw.text, '17'); assert.equal(store.getSnapshot().hasDraft, false);
});

test('personal chore departure discards invalid numbers and preserves already saved values', async () => {
  let attempts = 0;
  const chore = { id: 'test', enabled: true, load: 'normal', windowRadiusDays: 0, holidayPriority: false, estimatedMinutes: 15,
    frequencyDaysByMode: { balanced: 7 }, recommendedCycleDays: 7 };
  const editor = createChoreSettingsEditor(chore, 'balanced', async () => { attempts++; });
  editor.changeRadius('invalid'); let backs = 0; await editor.navigateAfterSave(() => backs++);
  assert.equal(backs, 1); assert.equal(editor.getSnapshot().draft.radiusText, '0'); assert.equal(attempts, 0);
  editor.resumeNavigation(); editor.changeRadius('2'); await editor.flush(); editor.changeRadius('bad');
  await editor.navigateAfterSave(() => backs++); assert.equal(editor.getSnapshot().draft.radiusText, '2'); assert.equal(attempts, 1);
});
