import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivatePreferenceEditor } from '../src/features/sharing/private-planner/preference-editor.ts';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';

const defaults = () => ({ timeZone: 'Asia/Tokyo', restDays: [6, 7], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] });
function fixture(t) {
  const f = privateCalendarSetupFixture(t, { userId: 'private-editor-owner' }); const calls = [];
  const actual = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.vault, exclusive: f.exclusive,
    assertOwner: owner => assert.equal(f.state.currentUser, owner, 'account changed') });
  const port = { ...actual, save: async (revision, value) => { calls.push({ revision, value: structuredClone(value) }); return actual.save(revision, value); } };
  const create = (extra = {}) => createPrivatePreferenceEditor({ store: port, saved: null, defaults: defaults(), delayMs: 60_000, ...extra });
  return { f, actual, calls, port, create };
}

test('private preference editor does not save defaults or invent permitted hours when opened or left unchanged', async t => {
  const f = fixture(t); const editor = f.create(); let moves = 0;
  assert.equal(editor.getSnapshot().hasDraft, false); assert.equal(editor.getSnapshot().revision, 0);
  assert.equal(await editor.navigateAfterSave(() => moves++), true); assert.equal(moves, 1); assert.equal(f.calls.length, 0); assert.equal(await f.actual.read(), null);
});

test('private preference editor saves only complete explicit clock bands and discards incomplete input on departure', async t => {
  const f = fixture(t); const editor = f.create(); let moves = 0;
  editor.addBand(1); assert.equal(await editor.flush(), false); assert.equal(f.calls.length, 0);
  editor.change(value => ({ ...value, bands: [{ ...value.bands[0], start: '19:' }] }));
  assert.equal(await editor.navigateAfterSave(() => moves++), true); assert.equal(editor.getSnapshot().navigationBlocked, false); assert.equal(moves, 1);
  assert.equal(editor.getSnapshot().raw.bands.length, 0); editor.resumeNavigation(); editor.addBand(1);
  editor.change(value => ({ ...value, bands: [{ ...value.bands[0], start: '19:00', end: '20:30' }] }));
  assert.equal(await editor.flush(), true); assert.equal(f.calls.length, 1); assert.equal(editor.getSnapshot().hasDraft, false);
  assert.deepEqual((await f.actual.read()).allowedBands, [{ weekday: 1, startMinute: 1140, endMinute: 1230 }]);
  assert.equal(await editor.navigateAfterSave(() => moves++), true); assert.equal(moves, 2);
});

test('private preference editor handles a midnight end and fullwidth input without accepting an overnight inversion', async t => {
  const f = fixture(t); const editor = f.create(); editor.addBand(5);
  editor.change(value => ({ ...value, bands: [{ ...value.bands[0], start: '２３：００', end: '24:00' }] }));
  assert.equal(await editor.flush(), true); assert.deepEqual((await f.actual.read()).allowedBands, [{ weekday: 5, startMinute: 1380, endMinute: 1440 }]);
  editor.change(value => ({ ...value, bands: [{ ...value.bands[0], start: '23:00', end: '01:00' }] }));
  assert.equal(await editor.flush(), false); assert.equal(f.calls.length, 1); assert.match(editor.getSnapshot().validation, /日をまたぐ/u);
  editor.discardDraft(); assert.equal(await editor.flush(), true);
});

test('private preference editor serializes edits made while a save is awaiting its response using the accepted revision', async t => {
  const f = fixture(t); let release; let entered; const gate = new Promise(done => { release = done; }); const started = new Promise(done => { entered = done; });
  let first = true; const editor = f.create({ store: { read: f.port.read, save: async (...args) => {
    const value = await f.port.save(...args); if (first) { first = false; entered(); await gate; } return value;
  } } });
  editor.change(value => ({ ...value, restDays: [1] })); const saving = editor.flush(); await started;
  editor.change(value => ({ ...value, restDays: [2] })); release(); assert.equal(await saving, true);
  assert.deepEqual(f.calls.map(value => value.revision), [0, 1]); assert.deepEqual((await f.actual.read()).restDays, [2]); assert.equal(editor.getSnapshot().revision, 2);
});

test('private preference editor retains incomplete latest input when an earlier valid save completes', async t => {
  const f = fixture(t); let release; let entered; const gate = new Promise(done => { release = done; }); const started = new Promise(done => { entered = done; });
  const editor = f.create({ store: { read: f.port.read, save: async (...args) => { const saved = await f.port.save(...args); entered(); await gate; return saved; } } });
  editor.change(value => ({ ...value, heavy: '3' })); const saving = editor.flush(); await started;
  editor.change(value => ({ ...value, heavy: '' })); release(); assert.equal(await saving, false);
  assert.equal(editor.getSnapshot().raw.heavy, ''); assert.equal(editor.getSnapshot().hasDraft, true); assert.equal((await f.actual.read()).loadLimits.heavyDailyLimit, 3);
  editor.discardDraft(); assert.equal(await editor.flush(), true); assert.equal(editor.getSnapshot().raw.heavy, '3');
});

test('private preference editor refuses stale conflicting updates and abandons rejected edits on departure', async t => {
  const f = fixture(t); const initial = await f.actual.save(0, defaults()); const editor = f.create({ saved: initial });
  await f.actual.save(1, { ...defaults(), restDays: [3] }); editor.change(value => ({ ...value, restDays: [4] }));
  assert.equal(await editor.flush(), false); assert.match(editor.getSnapshot().status.error, /別の操作/u);
  let moves = 0; assert.equal(await editor.navigateAfterSave(() => moves++), true); assert.equal(moves, 1);
  assert.equal(editor.getSnapshot().hasDraft, false); await editor.flush();
  assert.deepEqual((await f.actual.read()).restDays, [3]);
});

test('private preference editor removes a cleared queued change and cannot write after successful navigation', async t => {
  const f = fixture(t); const editor = f.create();
  editor.change(value => ({ ...value, normal: '9' })); editor.change(value => ({ ...value, normal: '' }));
  assert.equal(await editor.flush(), false); assert.equal(f.calls.length, 0); editor.discardDraft();
  assert.equal(await editor.navigateAfterSave(() => {}), true); editor.change(value => ({ ...value, normal: '8' }));
  assert.equal(await editor.flush(), true); assert.equal(f.calls.length, 0);
});
