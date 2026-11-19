import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { syntheticPdf } from './helpers/synthetic-pdf.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { openCalendarDay, selectCalendarView } from './helpers/calendar-ui.mjs';
import { verifyManualContent } from '../src/features/appliance-care/manual-document.ts';
import { openSavedManual } from '../src/features/appliance-care/open-saved-manual.ts';
import { calendarChoreTimeLabel } from '../src/features/calendar/chore-time-label.ts';
import { choreCalendarSpan } from '../src/domain/chores/calendar-timing.ts';
import { storeApplianceManualInside } from '../src/platform/storage/appliance-manual-storage.ts';
const repo = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { readApplianceManual } = await import('../src/platform/storage/appliance-manuals.ts');
const flush = async ui => { for (let i = 0; i < 18; i++) await ui.flush(); };
const originalClock = { allDay: false, startMinute: 600, endMinute: 615, endDayOffset: 0, timeZone: 'Asia/Tokyo' };
async function fixture(t, repeat = true) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T00:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await repo.initializeLocalDatabase(h.database);
  await repo.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1,2,3,4,5,6,7], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
  const chore = await repo.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.usability-create', name: '時刻を変更する家事', date: '2026-11-14', repeat, ...(repeat ? { intervalDays: 7 } : {}), timing: originalClock });
  const data = { database: h.database, snapshot: await repo.loadPlannerSnapshot(h.database), error: null, refresh: async () => { data.snapshot = await repo.loadPlannerSnapshot(h.database); } };
  const entry = data.snapshot.scheduleEntries.find(row => row.choreId === chore.id);
  return { ...h, chore, data, entry };
}

test('editing one timed chore occurrence retains its cadence future clocks retry identity and exact undo', async t => {
  const { database, chore, entry } = await fixture(t); const before = await repo.readPersonalChoreDate(database, chore.id, entry.id);
  assert.deepEqual(before.calendarTiming, originalClock);
  const timing = { ...originalClock, startMinute: 1380, endMinute: 45, endDayOffset: 1 };
  const command = { operationId: 'calendar-intent.usability-move', choreId: chore.id, roundId: entry.id, planRevision: before.planRevision,
    definition: before.signature, date: '2026-11-15', timing, recordedAt: new Date().toISOString() };
  await repo.movePersonalChoreDate(database, command); await repo.movePersonalChoreDate(database, command);
  let snapshot = await repo.loadPlannerSnapshot(database); const moved = snapshot.scheduleEntries.find(row => row.choreId === chore.id);
  assert.equal(moved.id, entry.id); assert.deepEqual(moved.calendarTime, choreCalendarSpan(command.date, timing));
  assert.equal((await repo.readPersonalCalendarChore(database, chore.id)).signature, before.signature);
  await assert.rejects(repo.movePersonalChoreDate(database, { ...command, timing: originalClock }), /同じ操作/);
  await assert.rejects(repo.movePersonalChoreDate(database, { ...command, operationId: 'calendar-intent.usability-stale', date: '2026-11-16' }), /更新/);
  await assert.rejects(repo.movePersonalChoreDate(database, { ...command, operationId: 'calendar-intent.usability-invalid', timing: { ...timing, endDayOffset: 0 } }), /終了/);
  t.mock.timers.setTime(Date.parse('2026-11-15T12:00:00Z'));
  const receipt = await repo.completeChoreWithReceipt(database, moved); assert.ok(receipt);
  snapshot = await repo.loadPlannerSnapshot(database); const next = snapshot.scheduleEntries.find(row => row.choreId === chore.id);
  assert.ok(next); assert.deepEqual(next.calendarTime, choreCalendarSpan(next.suggestedDate, originalClock), 'this occurrence does not rewrite future clocks');
  assert.equal(await repo.undoCompletionReceipt(database, receipt), true);
  assert.deepEqual((await repo.loadPlannerSnapshot(database)).scheduleEntries.find(row => row.choreId === chore.id).calendarTime, moved.calendarTime);
  assert.equal((await readLocalCalendar(database)).events.length, 0);
});

test('saved manual preview verifies original local bytes and refuses missing tampered or obsolete content without writes', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repo.initializeLocalDatabase(h.database);
  const content = syntheticPdf().toString('base64'); const verified = verifyManualContent(content);
  await storeApplianceManualInside(h.database, content, verified.sha256);
  const before = h.connection.prepare('SELECT total_changes() AS n').get().n; const shown = [];
  const input = { digest: verified.sha256, read: digest => readApplianceManual(h.database, digest), isCurrent: () => true,
    present: async (bytes, digest) => shown.push({ bytes, digest }) };
  await openSavedManual(input); assert.equal(shown.length, 1); assert.deepEqual(shown[0].bytes, verified.bytes); assert.equal(shown[0].digest, verified.sha256);
  await assert.rejects(openSavedManual({ ...input, read: async () => null }), /保存されていません/);
  await assert.rejects(openSavedManual({ ...input, read: async () => Buffer.from('%PDF-wrong original content more than thirty two bytes').toString('base64') }), /一致しません/);
  await openSavedManual({ ...input, isCurrent: () => false }); assert.equal(shown.length, 1);
  assert.equal(h.connection.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(await readApplianceManual(h.database, verified.sha256), content);
});

test('chore time labels preserve the display zone overnight dates and the absence of unspecified clocks', () => {
  assert.equal(calendarChoreTimeLabel(undefined, 'Asia/Tokyo'), undefined);
  assert.equal(calendarChoreTimeLabel(choreCalendarSpan('2026-11-14', originalClock), 'Asia/Tokyo'), '10:00–10:15');
  assert.equal(calendarChoreTimeLabel(choreCalendarSpan('2026-11-14', { ...originalClock, startMinute: 1380, endMinute: 15, endDayOffset: 1 }), 'Asia/Tokyo'), '23:00–翌日 00:15');
});

test('native manual viewing writes verified bytes locally and never presents an obsolete request after preparation', async () => {
  const bytes = verifyManualContent(syntheticPdf().toString('base64')).bytes; const calls = [];
  let current = true; let cancelDuringWrite = false;
  const viewer = loadNativeModule('src/platform/appliance-care/manual-viewer.ts', { 'expo-file-system': {
    Paths: { cache: 'file:///app-cache/' }, File: class {
      constructor(root, name) { calls.push(['file', root, name]); }
      create() {} async write(value) { assert.deepEqual(value, bytes); if (cancelDuringWrite) current = false; }
      async canPreview(options) { calls.push(['canPreview', options]); return true; }
      async preview(options) { calls.push(['preview', options]); }
    },
  } });
  await viewer.showManualPdf(bytes, 'a'.repeat(64), '掃除機の説明書', () => current);
  assert.equal(calls.filter(row => row[0] === 'preview').length, 1);
  assert.deepEqual(calls.find(row => row[0] === 'preview')[1], { mimeType: 'application/pdf', title: '掃除機の説明書' });
  cancelDuringWrite = true; await viewer.showManualPdf(bytes, 'a'.repeat(64), '掃除機の説明書', () => current);
  assert.equal(calls.filter(row => row[0] === 'preview').length, 1);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} notification recovery targets device permission settings and retains a system fallback`, async () => {
    const calls = []; let failUrl = false;
    const settings = loadNativeModule('src/platform/notifications/notification-settings.ts', { 'react-native': {
      Platform: { OS: platform }, Linking: { openURL: async url => { calls.push(url); if (failUrl) throw new Error('unsupported system route'); }, openSettings: async () => { calls.push('app-settings'); } },
    } });
    await settings.openDeviceNotificationSettings();
    assert.deepEqual(calls, [platform === 'ios' ? 'app-settings:notifications' : 'app-settings']);
    calls.length = 0; failUrl = true; await settings.openDeviceNotificationSettings();
    assert.deepEqual(calls, platform === 'ios' ? ['app-settings:notifications', 'app-settings'] : ['app-settings']);
  });
  test(`${platform} timed chore sheet edits start end and dates together only on explicit save`, async t => {
    const { database, chore, data, entry } = await fixture(t); let picker; let closed = 0;
    const before = await repo.readPersonalChoreDate(database, chore.id, entry.id);
    const ui = screenHarness('src/app/calendar-chore-date.tsx', { platform, effectDependencies: true, effect: fn => fn(), datePicker: value => { picker = value; }, mocks: {
      'expo-router': { router: { back: () => { closed++; } }, Stack: { Screen: 'StackScreen' }, useLocalSearchParams: () => ({ choreId: chore.id, entryId: entry.id }) },
      '../../hooks/use-planner-data': { usePlannerData: () => data },
    } }); t.after(() => ui.unmount()); await flush(ui);
    const pick = async (label, date) => {
      await ui.press(`${label}を選択`);
      if (platform === 'ios') { ui.nodes().find(row => row.type === 'DateTimePicker').props.onValueChange({}, new Date(date)); await ui.flush(); await ui.press(`${label}の選択を完了`); }
      else { picker.onValueChange({}, new Date(date)); await ui.flush(); }
    };
    await pick('開始日', '2026-11-16T12:00:00Z'); await pick('開始時刻', '2026-11-16T19:00:00Z');
    assert.equal(ui.button('終了時刻を選択').props.accessibilityValue.text, '19:15');
    await pick('終了時刻', '2026-11-16T20:30:00Z');
    assert.deepEqual(await repo.readPersonalChoreDate(database, chore.id, entry.id), before, 'picking values is not a save');
    const save = ui.button('今回の日時を保存'); save.props.onPress(); save.props.onPress(); await flush(ui);
    assert.equal(closed, 1); const after = await repo.loadPlannerSnapshot(database);
    assert.deepEqual(after.scheduleEntries.find(row => row.id === entry.id).calendarTime,
      choreCalendarSpan('2026-11-16', { ...originalClock, startMinute: 1140, endMinute: 1230 }));
    assert.equal((await repo.readPersonalCalendarChore(database, chore.id)).signature, before.signature);
  });

  test(`${platform} list calendars show explicit chore clocks once while day cards retain their original action`, async t => {
    const { database, chore, data } = await fixture(t, false);
    const ui = screenHarness('src/app/(tabs)/explore.tsx', { platform, database, snapshot: () => data.snapshot, mocks: {
      '@/components/workspace-tab': { WorkspaceTab: props => props.children },
      '@/features/calendar/use-local-calendar': { useLocalCalendar: () => undefined },
    } }); t.after(() => ui.unmount()); await openCalendarDay(ui, '2026-11-14'); await selectCalendarView(ui, 'リスト表示');
    assert.ok(ui.text().includes('10:00–10:15'));
    assert.equal(ui.nodes().filter(row => row.props.accessibilityLabel === `${chore.name}の今回の日付を変更`).length, 1);
    assert.ok(!ui.nodes().some(row => row.props.accessibilityRole === 'checkbox'));
    await selectCalendarView(ui, '1日表示');
    assert.ok(ui.nodes().some(row => row.props.accessibilityLabel === `${chore.name}を編集`));
    assert.equal(ui.button(`${chore.name}の今回の日付を変更`).props.accessibilityValue, undefined);
  });

  test(`${platform} compact calendar sources are accessible while home completion and guide actions stay intact`, async () => {
    for (const source of ['personal', 'shared']) {
      let opened = 0; let completed = 0;
      const props = { compact: true, mixedSources: true, source, chore: { id: 'bath', name: '浴室の清掃', householdId: '' },
        onOpen: () => { opened++; }, onToggle: () => { completed++; }, calendarTimeLabel: '10:00–10:15' };
      const ui = screenHarness('src/components/task-checkbox-row.tsx', { platform, exportName: 'TaskCheckboxRow', props });
      try {
        const row = ui.button('浴室の清掃の説明を開く'); assert.ok(row.props.accessibilityHint.includes(source === 'personal' ? '個人の家事' : '共有の家事'));
        assert.equal(row.props.accessibilityValue.text, '10:00–10:15'); await ui.press('浴室の清掃の説明を開く'); assert.equal(opened, 1); assert.equal(completed, 0);
        props.compact = false; props.home = true; ui.render();
        const checkbox = ui.nodes().find(row => row.props.accessibilityRole === 'checkbox' && row.props.accessibilityLabel === '浴室の清掃を完了');
        assert.ok(checkbox); checkbox.props.onPress(); await ui.flush(); assert.equal(completed, 1);
      } finally { ui.unmount(); }
    }
  });

  test(`${platform} manual action opens the retained original once and cancels an opening after the displayed account changes`, async () => {
    const content = syntheticPdf().toString('base64'); const { sha256 } = verifyManualContent(content); let read; let reads = 0; const shown = [];
    const props = { database: {}, digest: sha256, label: '掃除機', accessKey: 'account-a:appliance' };
    const ui = screenHarness('src/features/appliance-care/appliance-manual-action.tsx', { platform, exportName: 'ApplianceManualAction', props, effectDependencies: true, layoutEffect: fn => fn(), mocks: {
      '../../platform/storage/appliance-manuals': { readApplianceManual: async () => { reads++; return new Promise(resolve => { read = resolve; }); } },
      '../../platform/appliance-care/manual-viewer': { showManualPdf: async (bytes, digest, title, guard) => { assert.ok(guard()); shown.push({ bytes, digest, title }); } },
    } });
    try {
      const button = ui.button('説明書を開く'); button.props.onPress(); button.props.onPress(); await ui.flush(); assert.equal(reads, 1);
      read(content); await flush(ui); assert.equal(shown.length, 1); assert.equal(shown[0].title, '掃除機の説明書');
      assert.deepEqual(shown[0].bytes, verifyManualContent(content).bytes);
      await ui.press('説明書を開く'); props.accessKey = 'account-b:appliance'; ui.render(); read(content); await flush(ui); assert.equal(shown.length, 1);
    } finally { ui.unmount(); }
  });

  test(`${platform} denied notifications open device settings and finish only the pending enable request after permission is granted`, async () => {
    let listener; let opened = 0; let granted = false; let enabled = 0;
    const props = { scope: 'personal', checkPermission: async () => granted, onGranted: async () => { enabled++; } };
    const ui = screenHarness('src/features/notifications/notification-permission-recovery.tsx', { platform, exportName: 'NotificationPermissionRecovery', props,
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), appStateListener: fn => { listener = fn; }, openSettings: async () => { opened++; } });
    try {
      listener('active'); await flush(ui); assert.equal(enabled, 0);
      const button = ui.button('端末の設定を開く'); button.props.onPress(); button.props.onPress(); await flush(ui); assert.equal(opened, 1);
      listener('active'); await flush(ui); assert.equal(enabled, 0);
      granted = true; listener('active'); await flush(ui); assert.equal(enabled, 0, 'a previous visit that ended without granting must not auto-enable later');
      await ui.press('端末の設定を開く'); listener('active'); listener('active'); await flush(ui); assert.equal(enabled, 1);
      listener('active'); await flush(ui); assert.equal(enabled, 1);
      await ui.press('端末の設定を開く'); props.scope = 'another-account'; ui.render(); listener('active'); await flush(ui); assert.equal(enabled, 1);
    } finally { ui.unmount(); }
  });

  test(`${platform} calendar notification denial preserves the saved switch and exposes the device settings recovery action`, async () => {
    let permitted = false; const writes = []; let listener; const settings = { enabled: false };
    const ui = screenHarness('src/features/calendar/calendar-notification-settings.tsx', { platform, exportName: 'CalendarNotificationSettings', props: { database: {} },
      effectDependencies: true, effect: fn => fn(), layoutEffect: fn => fn(), appStateListener: fn => { listener = fn; }, mocks: {
        './use-calendar-reminders': { useCalendarReminders: () => ({ settings, loading: false, error: null }) },
        '../../platform/storage/calendar-reminders': { setCalendarNotificationsEnabled: async (_db, value) => { writes.push(value); settings.enabled = value; } },
        '../../platform/notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: { requestPermission: async () => permitted, hasPermission: async () => permitted } },
      } });
    try {
      ui.nodes().find(row => row.props.accessibilityRole === 'checkbox').props.onPress(); await flush(ui);
      assert.equal(settings.enabled, false); assert.deepEqual(writes, []);
      await ui.press('端末の設定を開く'); permitted = true; listener('active'); await flush(ui);
      assert.deepEqual(writes, [true]); assert.equal(settings.enabled, true);
      assert.ok(!ui.nodes().some(row => row.props.accessibilityLabel === '端末の設定を開く'));
    } finally { ui.unmount(); }
  });
}
