import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { createAutosaveQueue } from '../src/features/settings/autosave-queue.ts';
import { applyChoreSettingsPatch, parseSettingInteger } from '../src/domain/chores/settings-patch.ts';
import { localDateFromDate } from '../src/domain/scheduling/local-date.ts';

const repository = await import('../src/platform/storage/repository.ts');
const today = localDateFromDate(new Date());
async function context() {
  const h = createDatabase();
  await repository.initializeLocalDatabase(h.database);
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
  let snapshot;
  const refresh = async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); };
  await refresh();
  const chore = snapshot.chores.find((item) => item.id === 'liflow-catalog-6.007' && !item.archived);
  const options = { database: h.database, snapshot: () => snapshot, refresh, params: { id: chore.id } };
  return { ...h, chore, options, refresh, snapshot: () => snapshot };
}
const input = (screen, name) => screen.nodes().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === name);
const switchFor = (screen, name) => screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === name);

test('autosave validates integer drafts including full-width digits without accepting partial or scientific input', () => {
  assert.equal(parseSettingInteger(' １７ ', 1, 3650), 17);
  assert.equal(parseSettingInteger('0', 0, 14), 0);
  for (const text of ['', ' ', '-1', '1.5', '1e2', 'Infinity', 'NaN', '3651', '1x']) assert.equal(parseSettingInteger(text, 1, 3650), undefined, text);
});

test('autosave coalesces rapid numeric edits and repeated flushes into one write', async () => {
  const writes = [];
  const queue = createAutosaveQueue({ save: async (patch) => { writes.push(patch); }, delayMs: 10 });
  queue.enqueue({ cycleDays: 1 }); queue.enqueue({ cycleDays: 17 }); queue.enqueue({ windowRadiusDays: 2 });
  await delay(30);
  await Promise.all([queue.flush(), queue.flush()]);
  assert.deepEqual(writes, [{ cycleDays: 17, windowRadiusDays: 2 }]);
  assert.equal(queue.getSnapshot().phase, 'saved');
});

test('autosave serializes slow writes and retains the final toggle and edits made during saving', async () => {
  const writes = []; let release; let active = 0; let maximum = 0;
  const queue = createAutosaveQueue({ save: async (patch) => {
    writes.push(patch); active++; maximum = Math.max(maximum, active);
    if (writes.length === 1) await new Promise((resolve) => { release = resolve; });
    active--;
  } });
  queue.enqueue({ enabled: true }, true);
  queue.enqueue({ enabled: false }, true);
  queue.enqueue({ cycleDays: 7 }); queue.enqueue({ cycleDays: 30 });
  release(); await queue.flush();
  assert.equal(maximum, 1);
  assert.deepEqual(writes, [{ enabled: true }, { enabled: false, cycleDays: 30 }]);
});

test('autosave publishes its running writer before notifying reentrant subscribers', async () => {
  const writes = []; let active = 0; let maximum = 0; let triggered = false; let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const queue = createAutosaveQueue({ save: async (patch) => {
    writes.push(patch); active++; maximum = Math.max(maximum, active);
    await blocked; active--;
  } });
  queue.subscribe(() => {
    if (queue.getSnapshot().phase === 'saving' && !triggered) {
      triggered = true;
      queue.enqueue({ cycleDays: 21 }, true);
    }
  });
  queue.enqueue({ cycleDays: 14 }, true);
  const inFlight = queue.flush();
  release(); await inFlight;
  assert.equal(maximum, 1);
  assert.deepEqual(writes, [{ cycleDays: 14 }, { cycleDays: 21 }]);
  assert.equal(queue.getSnapshot().phase, 'saved');
});

test('autosave drains edits enqueued synchronously by a saved-state observer', async () => {
  const writes = []; let triggered = false;
  const queue = createAutosaveQueue({ save: async (patch) => { writes.push(patch); } });
  queue.subscribe(() => {
    if (queue.getSnapshot().phase === 'saved' && !triggered) {
      triggered = true; queue.enqueue({ enabled: false }, true);
    }
  });
  queue.enqueue({ cycleDays: 17 }); await queue.flush();
  assert.deepEqual(writes, [{ cycleDays: 17 }, { enabled: false }]);
});

test('autosave failed patches can be retried with the latest values instead of overwriting them', async () => {
  const writes = []; let fail = true;
  const queue = createAutosaveQueue({ save: async (patch) => { writes.push(patch); if (fail) throw new Error('保存失敗'); } });
  queue.enqueue({ cycleDays: 7, enabled: true });
  assert.equal(await queue.flush(), false);
  assert.equal(queue.getSnapshot().error, '保存失敗');
  fail = false; queue.enqueue({ cycleDays: 30 });
  assert.equal(await queue.flush(), true);
  assert.deepEqual(writes[1], { cycleDays: 30, enabled: true });
});

test('autosave retries do not resurrect a numeric field cleared during a failed write', async () => {
  const writes = []; let reject;
  const queue = createAutosaveQueue({ save: async (patch) => { writes.push(patch); if (writes.length === 1) await new Promise((_yes, no) => { reject = no; }); } });
  queue.enqueue({ cycleDays: 7, enabled: true }, true);
  queue.remove('cycleDays'); reject(new Error('保存失敗'));
  assert.equal(await queue.flush(), false);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(writes, [{ cycleDays: 7, enabled: true }, { enabled: true }]);
  queue.enqueue({ cycleDays: 21 }); await queue.flush(); assert.deepEqual(writes.at(-1), { cycleDays: 21 });
});

test('autosave partial DB updates preserve fresh metadata and concurrent changes to other settings', async () => {
  const h = await context();
  try {
    await repository.updateChoreDefinition(h.database, { ...h.chore, name: '最新の家事名', tools: ['変更後の道具'] });
    await Promise.all([
      repository.updateChoreSettings(h.database, h.chore.id, { cycleDays: 17, enabled: true }),
      repository.updateChoreSettings(h.database, h.chore.id, { windowRadiusDays: 3, load: 'heavy' }),
    ]);
    await h.refresh(); const saved = h.snapshot().chores.find((item) => item.id === h.chore.id);
    assert.equal(saved.name, '最新の家事名'); assert.deepEqual(saved.tools, ['変更後の道具']);
    assert.equal(saved.recommendedCycleDays, 17); assert.equal(saved.windowRadiusDays, 3); assert.equal(saved.load, 'heavy'); assert.equal(saved.enabled, true);
  } finally { h.connection.close(); }
});

test('autosave unchanged settings do not write or invalidate the shared cached planner', async () => {
  const h = await context();
  try {
    // Choosing a width for the first time pins it against future adaptive
    // changes, even if its value equals today's default. Repeating it is a no-op.
    await repository.updateChoreSettings(h.database, h.chore.id, { windowRadiusDays: h.chore.windowRadiusDays }); await h.refresh();
    const before = repository.readCachedPlannerSnapshot(h.database);
    const writeCount = h.writes.length;
    assert.equal(await repository.updateChoreSettings(h.database, h.chore.id, { enabled: h.chore.enabled, load: h.chore.load, windowRadiusDays: h.chore.windowRadiusDays }), false);
    assert.equal(h.writes.length, writeCount);
    assert.equal(repository.readCachedPlannerSnapshot(h.database), before);
    for (const patch of [{ cycleDays: 0 }, { cycleDays: Number.MAX_SAFE_INTEGER + 1 }, { windowRadiusDays: -1 }, { windowRadiusDays: 15 }, { load: 'invalid' }, { laundryDryingPreference: 'invalid' }]) {
      await assert.rejects(repository.updateChoreSettings(h.database, h.chore.id, patch));
    }
    assert.equal(h.writes.length, writeCount, 'invalid input must not alter the database');
  } finally { h.connection.close(); }
});

test('individual settings save numeric edits automatically without a save button and persist on reopening', async () => {
  const h = await context();
  try {
    const screen = screenHarness('src/app/chores/[id].tsx', h.options);
    assert.ok(!screen.text().includes('個別設定を保存'));
    await screen.change('家事周期の日数', '17');
    await delay(500); await screen.flush();
    assert.equal(h.snapshot().chores.find((item) => item.id === h.chore.id).recommendedCycleDays, 17);
    switchFor(screen, '家事を有効にする').props.onValueChange(true); await screen.flush();
    await screen.press('重い'); await screen.press('外干し');
    switchFor(screen, '休日を優先').props.onValueChange(true); await screen.flush();
    await screen.change('実施期間の日数幅', '3'); await screen.endEditing('実施期間の日数幅');
    const reopened = screenHarness('src/app/chores/[id].tsx', h.options);
    assert.equal(input(reopened, '家事周期の日数').props.value, '17');
    assert.equal(input(reopened, '実施期間の日数幅').props.value, '3');
    const saved = h.snapshot().chores.find((item) => item.id === h.chore.id);
    assert.equal(saved.enabled, true); assert.equal(saved.load, 'heavy'); assert.equal(saved.holidayPriority, true); assert.equal(saved.laundryDryingPreference, 'outdoors');
  } finally { h.connection.close(); }
});

test('personal cycle autosave accepts long positive intervals without a product cap and rejects unsafe integers without overwriting the saved value', async () => {
  const h = await context();
  try {
    const screen = screenHarness('src/app/chores/[id].tsx', h.options);
    await screen.change('家事周期の日数', '4000'); await screen.endEditing('家事周期の日数');
    assert.equal(h.snapshot().chores.find(item => item.id === h.chore.id).recommendedCycleDays, 4000);
    await screen.change('家事周期の日数', String(Number.MAX_SAFE_INTEGER + 1)); await screen.endEditing('家事周期の日数');
    assert.equal(h.snapshot().chores.find(item => item.id === h.chore.id).recommendedCycleDays, 4000);
    assert.ok(screen.text().includes('周期は1日以上'));
  } finally { h.connection.close(); }
});

test('individual settings keep invalid drafts out of the DB while saving independent toggles', async () => {
  const h = await context();
  try {
    const screen = screenHarness('src/app/chores/[id].tsx', h.options);
    await screen.change('家事周期の日数', '1e2');
    await screen.change('実施期間の日数幅', '999');
    switchFor(screen, '家事を有効にする').props.onValueChange(true); await screen.flush();
    const saved = h.snapshot().chores.find((item) => item.id === h.chore.id);
    assert.equal(saved.enabled, true); assert.equal(saved.windowRadiusDays, h.chore.windowRadiusDays); assert.equal(saved.recommendedCycleDays, h.chore.recommendedCycleDays);
    assert.ok(screen.text().includes('周期は1日以上') && screen.text().includes('期間幅は±0〜±14'));
    await screen.change('家事周期の日数', '２１'); await screen.change('実施期間の日数幅', '0'); await screen.endEditing('家事周期の日数');
    assert.equal(h.snapshot().chores.find((item) => item.id === h.chore.id).recommendedCycleDays, 21);
  } finally { h.connection.close(); }
});

for (const event of ['back', 'blur', 'background']) {
  test(`autosave flushes pending numeric input on ${event}`, async () => {
    const h = await context();
    try {
      let focus, stateListener; const effects = []; const calls = [];
      const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options, navigate: (...args) => calls.push(args),
        focusEffect: (callback) => { focus = callback; }, effect: (callback) => effects.push(callback), appStateListener: (callback) => { stateListener = callback; } });
      const leave = focus(); const cleanups = effects.map((callback) => callback());
      await screen.change('家事周期の日数', '21');
      if (event === 'back') await screen.press('前の画面に戻る');
      else if (event === 'blur') { leave(); await screen.flush(); }
      else { stateListener('inactive'); await screen.flush(); }
      assert.equal(h.snapshot().chores.find((item) => item.id === h.chore.id).recommendedCycleDays, 21);
      if (event === 'back') assert.deepEqual(calls, [['back']]);
      for (const cleanup of cleanups) cleanup?.();
    } finally { h.connection.close(); }
  });
}

for (const event of ['blur', 'background', 'unmount']) {
  test(`autosave restores a cleared cycle when leaving through ${event} without a native blur event`, async () => {
    const h = await context();
    try {
      await repository.updateChoreSettings(h.database, h.chore.id, { cycleDays: 17, enabled: false }); await h.refresh();
      let focus, stateListener; const effects = [];
      const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options,
        focusEffect: (callback) => { focus = callback; }, effect: (callback) => effects.push(callback),
        appStateListener: (callback) => { stateListener = callback; } });
      const leave = focus(); const cleanups = effects.map((callback) => callback());
      await screen.change('家事周期の日数', '');
      if (event === 'blur') leave();
      else if (event === 'background') stateListener('inactive');
      else for (const cleanup of cleanups) cleanup?.();
      await screen.flush();
      const saved = h.snapshot().chores.find((item) => item.id === h.chore.id);
      assert.equal(saved.recommendedCycleDays, undefined);
      assert.equal(saved.enabled, false);
      if (event !== 'unmount') for (const cleanup of cleanups) cleanup?.();
      await screen.flush();
    } finally { h.connection.close(); }
  });
}

for (const manufacturerDays of [undefined, 30]) {
  for (const event of ['blur', 'background', 'unmount']) {
    test(`autosave clears an appliance override with manufacturer cycle ${manufacturerDays} on ${event}`, async () => {
      const h = await context();
      try {
        const task = { name: 'フィルターのお手入れ', ...(manufacturerDays ? { recommendedIntervalDays: manufacturerDays } : {}),
          steps: ['公式手順を保持'], tools: ['布'], safetyCautions: ['電源を切る'], evidence: [{ url: 'https://www.dyson.co.jp/support' }] };
        const result = await repository.saveReviewedApplianceCare(h.database,
          { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', manualUrl: 'https://www.dyson.co.jp/support' },
          { manufacturer: 'Dyson', model: 'SV20', tasks: [task], analyzedAt: new Date().toISOString(), requiresUserReview: true }, [{ task, userIntervalDays: 17 }]);
        await h.refresh();
        const chore = h.snapshot().chores.find((item) => item.applianceId === result.applianceId);
        if (manufacturerDays) await repository.updateChoreSettings(h.database, chore.id, { enabled: false });
        await h.refresh();
        let focus, stateListener; const effects = [];
        const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options, params: { id: chore.id },
          focusEffect: (callback) => { focus = callback; }, effect: (callback) => effects.push(callback),
          appStateListener: (callback) => { stateListener = callback; } });
        const leave = focus(); const cleanups = effects.map((callback) => callback());
        await screen.change('家事周期の日数', '');
        if (event === 'blur') leave(); else if (event === 'background') stateListener('background');
        else for (const cleanup of cleanups) cleanup?.();
        await screen.flush();
        const saved = h.snapshot().chores.find((item) => item.id === chore.id);
        assert.equal(saved.userIntervalDays, undefined);
        assert.equal(Boolean(saved.requiresCycleSelection), false);
        assert.equal(saved.enabled, manufacturerDays === undefined);
        assert.deepEqual(saved.instructions, chore.instructions);
        if (event !== 'unmount') for (const cleanup of cleanups) cleanup?.();
        await screen.flush();
      } finally { h.connection.close(); }
    });
  }
}

test('individual settings show failed saves and retry the retained draft', async () => {
  const h = await context();
  try {
    let fail = true; const navigation = [];
    const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options, navigate: (...args) => navigation.push(args), mocks: { '@/platform/storage/repository': { ...repository, updateChoreSettings: async (...args) => {
      if (fail) throw new Error('保存失敗'); return repository.updateChoreSettings(...args);
    } } } });
    switchFor(screen, '家事を有効にする').props.onValueChange(true); await screen.flush();
    assert.equal(h.snapshot().chores.find((item) => item.id === h.chore.id).enabled, false);
    assert.equal(switchFor(screen, '家事を有効にする').props.value, true);
    assert.ok(screen.text().includes('保存失敗'));
    await screen.press('前の画面に戻る'); assert.deepEqual(navigation, [], 'failed writes must keep the draft on screen');
    fail = false; await screen.press('保存を再試行');
    assert.equal(h.snapshot().chores.find((item) => item.id === h.chore.id).enabled, true);
    await screen.press('前の画面に戻る'); assert.deepEqual(navigation, [['back']]);
  } finally { h.connection.close(); }
});

test('private appliance autosave supports necessary-only reset and preserves explicit disabling without requiring another fixed cycle', async () => {
  const h = await context();
  try {
    const task = { name: '汚れを拭く', steps: ['布で拭く'], tools: ['布'], safetyCautions: [], evidence: [{ url: 'https://www.dyson.co.jp/support' }] };
    const saved = await repository.saveReviewedApplianceCare(h.database,
      { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', manualUrl: 'https://www.dyson.co.jp/support' },
      { manufacturer: 'Dyson', model: 'SV20', tasks: [task], analyzedAt: new Date().toISOString(), requiresUserReview: true }, [{ task, userIntervalDays: 14 }]);
    await h.refresh(); const chore = h.snapshot().chores.find((item) => item.applianceId === saved.applianceId);
    await repository.updateChoreSettings(h.database, chore.id, { cycleDays: null }); await h.refresh();
    const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options, params: { id: chore.id } });
    assert.equal(switchFor(screen, '家事を有効にする').props.disabled, false);
    await screen.change('家事周期の日数', '14'); await screen.endEditing('家事周期の日数');
    assert.equal(h.snapshot().chores.find((item) => item.id === chore.id).enabled, true);
    switchFor(screen, '家事を有効にする').props.onValueChange(false); await screen.flush();
    await screen.change('家事周期の日数', '21'); await screen.endEditing('家事周期の日数');
    assert.equal(h.snapshot().chores.find((item) => item.id === chore.id).enabled, false);
    await screen.change('家事周期の日数', ''); await screen.endEditing('家事周期の日数');
    const cleared = h.snapshot().chores.find((item) => item.id === chore.id);
    assert.equal(cleared.requiresCycleSelection, false); assert.equal(cleared.enabled, false); assert.equal(cleared.userIntervalDays, undefined);
    assert.equal(applyChoreSettingsPatch(cleared, { enabled: true }).enabled, true);
  } finally { h.connection.close(); }
});

test('autosave back taps do not pop multiple screens while a save is pending', async () => {
  const h = await context();
  try {
    const calls = [];
    const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options, navigate: (...args) => calls.push(args) });
    await screen.change('家事周期の日数', '30');
    const back = screen.button('前の画面に戻る');
    back.props.onPress(); back.props.onPress(); await screen.flush();
    assert.deepEqual(calls, [['back']]);
    assert.equal(h.snapshot().chores.find((item) => item.id === h.chore.id).recommendedCycleDays, 30);
  } finally { h.connection.close(); }
});

test('clearing a built-in cycle restores its frequency-mode default and preserves explicit disabling', async () => {
  const h = await context();
  try {
    const screen = screenHarness('src/app/chores/[id].tsx', h.options);
    await screen.change('家事周期の日数', '17'); await screen.endEditing('家事周期の日数');
    switchFor(screen, '家事を有効にする').props.onValueChange(false); await screen.flush();
    await screen.change('家事周期の日数', ''); await screen.endEditing('家事周期の日数');
    const saved = h.snapshot().chores.find((item) => item.id === h.chore.id);
    assert.equal(saved.recommendedCycleDays, undefined); assert.equal(saved.enabled, false);
    assert.equal(input(screen, '家事周期の日数').props.value, String(h.chore.frequencyDaysByMode.balanced));
  } finally { h.connection.close(); }
});

test('appliance autosave restores manufacturer cycles without changing steps or silently reenabling a disabled task', async () => {
  const h = await context();
  try {
    const task = { name: 'フィルターを洗う', recommendedIntervalDays: 30, steps: ['公式の手順を維持'], tools: ['水'], safetyCautions: ['乾燥する'], evidence: [{ url: 'https://www.dyson.co.jp/support' }] };
    const saved = await repository.saveReviewedApplianceCare(h.database,
      { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', manualUrl: 'https://www.dyson.co.jp/support' },
      { manufacturer: 'Dyson', model: 'SV20', tasks: [task], analyzedAt: new Date().toISOString(), requiresUserReview: true }, [{ task }]);
    await h.refresh(); const chore = h.snapshot().chores.find((item) => item.applianceId === saved.applianceId);
    const screen = screenHarness('src/app/chores/[id].tsx', { ...h.options, params: { id: chore.id } });
    await screen.change('家事周期の日数', '17'); await screen.endEditing('家事周期の日数');
    switchFor(screen, '家事を有効にする').props.onValueChange(false); await screen.flush();
    await screen.change('家事周期の日数', ''); await screen.endEditing('家事周期の日数');
    const actual = h.snapshot().chores.find((item) => item.id === chore.id);
    assert.equal(actual.manufacturerRecommendedIntervalDays, 30); assert.equal(actual.userIntervalDays, undefined); assert.equal(actual.recommendedCycleDays, undefined);
    assert.equal(actual.enabled, false); assert.equal(input(screen, '家事周期の日数').props.value, '30');
    assert.deepEqual(actual.steps, chore.steps); assert.deepEqual(actual.applianceCareSource, chore.applianceCareSource);
  } finally { h.connection.close(); }
});

test('autosave observer failures cannot discard pending input or abort the durable write', async () => {
  const writes = []; let observedSaved = false;
  const queue = createAutosaveQueue({ save: async (patch) => { writes.push(patch); }, delayMs: 60000 });
  queue.subscribe(() => { throw new Error('view failed'); });
  queue.subscribe(() => { if (queue.getSnapshot().phase === 'saved') observedSaved = true; });
  queue.enqueue({ cycleDays: 17 }); assert.equal(await queue.flush(), true);
  assert.deepEqual(writes, [{ cycleDays: 17 }]); assert.equal(observedSaved, true); assert.equal(queue.getSnapshot().phase, 'saved');
});
