import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

function requests(platform, { reader, compact = false } = {}) {
  let owner = 'owner', reads = 0, changed, stops = 0;
  const routes = [];
  const model = { viewerUserId: 'owner', adminUserId: 'owner', plan: { groupId: 'house', initialized: true, occurrences: [], members: [], chores: [] },
    requests: [], requestReviews: [], assignmentRequests: [], assignmentReviews: [] };
  const workspace = { userId: 'owner', groupId: 'house', protocol: 2, record: async () => ({}), session: { controller: { actions: {}, readModel: async () => {
    reads++; return reader ? reader(model) : model;
  } } } };
  const screen = screenHarness('src/features/sharing/group-request-sections.tsx', { platform, exportName: 'GroupRequestSections',
    effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
    props: { workspace, busy: false, compact, run: async work => { await work(); return true; } }, navigate: (...args) => routes.push(args), mocks: {
      '@/hooks/use-workspace': { useWorkspace: () => ({ userId: owner }) },
      '@/features/sharing/v2-ui/workspace-data': { useOptionalWorkspaceDisplay: () => null },
      '@/platform/sharing/workspaces': { subscribeSharingChanges: callback => { changed = callback; return () => { stops++; }; } },
    } });
  return { screen, workspace, model, routes, reads: () => reads, stops: () => stops, changed: value => changed?.(value), account: value => { owner = value; screen.render(); } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} short request summaries appear inline without navigation and never present unread requests as empty`, async () => {
    let finish; const pending = new Promise(resolve => { finish = resolve; });
    const ui = requests(platform, { compact: true, reader: async model => { await pending; return model; } });
    try {
      assert.equal(ui.screen.text().includes('なし'), false); assert.equal(ui.reads(), 0);
      await Promise.resolve(); await Promise.resolve(); finish(); await ui.screen.flush();
      assert.match(ui.screen.text(), /日時変更なし担当変更なし/u); assert.deepEqual(ui.routes, []);
      assert.ok(!ui.screen.nodes().some(row => row.props.accessibilityState?.expanded !== undefined));
    } finally { finish(); ui.screen.unmount(); }
  });
  test(`${platform} group request page shares one local read and displays both request types without nested scroll lists`, async () => {
    const ui = requests(platform); const { screen } = ui;
    try {
      await screen.flush(); assert.equal(ui.reads(), 1);
      assert.deepEqual(screen.nodes().filter(node => node.props.accessibilityRole === 'header').map(node => node.children.join('')), ['日時変更', '担当変更']);
      assert.deepEqual(ui.routes, []); assert.equal((screen.text().match(/申請はありません。/gu) ?? []).length, 2);
      assert.ok(!screen.nodes().some(node => node.type === 'FlatList' || node.type === 'ScrollView'));
      ui.changed({ userId: 'another-owner', groupId: 'house' }); ui.changed({ userId: 'owner', groupId: 'house', statusOnly: true });
      await screen.flush(); assert.equal(ui.reads(), 1);
      ui.changed({ userId: 'owner', groupId: 'house' }); await screen.flush(); assert.equal(ui.reads(), 2);
      screen.unmount();
      assert.equal(ui.stops(), 1); ui.changed({ userId: 'owner', groupId: 'house' }); await Promise.resolve(); assert.equal(ui.reads(), 2);
      assert.ok(!screen.nodes().length);
    } finally { screen.unmount(); }
  });

  test(`${platform} inline requests reject foreign state and ignore account changes during a pending read`, async () => {
    let resolve; const gate = new Promise(done => { resolve = done; });
    const ui = requests(platform, { reader: async model => { await gate; return model; } });
    try {
      ui.account('other'); resolve(); await ui.screen.flush();
      assert.ok(!ui.screen.text().includes('申請はありません。')); assert.deepEqual(ui.routes, []);
    } finally { resolve(); ui.screen.unmount(); }
    const foreign = requests(platform, { reader: async model => ({ ...model, viewerUserId: 'other' }) });
    try {
      await foreign.screen.flush();
      assert.ok(foreign.screen.nodes().some(node => node.props.accessibilityRole === 'alert'));
      assert.ok(!foreign.screen.text().includes('申請はありません。'));
    } finally { foreign.screen.unmount(); }
  });

  test(`${platform} inline request read errors retain an explicit retry without sending a request`, async () => {
    let failed = true; const ui = requests(platform, { reader: async model => { if (failed) throw new Error('synthetic local read failure'); return model; } });
    try {
      await ui.screen.flush();
      assert.ok(ui.screen.nodes().some(node => node.props.accessibilityRole === 'alert')); assert.equal(ui.reads(), 1);
      failed = false; await ui.screen.press('申請を再読込'); assert.equal(ui.reads(), 2);
      assert.ok(ui.screen.text().includes('申請はありません。')); assert.deepEqual(ui.routes, []);
    } finally { ui.screen.unmount(); }
  });
}
