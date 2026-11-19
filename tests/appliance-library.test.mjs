import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform} appliance kinds are visible alongside retained model identity and open the original saved item`, async () => {
    const item = { id: 'washer', source: 'personal', manufacturer: 'Panasonic', productName: 'NA-TEST', modelNumber: 'QA-1', category: 'washing_machine', displayName: 'Panasonic NA-TEST（QA-1）' };
    const before = structuredClone(item), calls = [];
    const review = { ...item, id: 'review', source: 'shared', displayName: '二階の洗濯機', needsReview: true };
    const screen = screenHarness('src/features/appliance-care/appliance-library.tsx', { exportName: 'ApplianceLibrary', platform,
      props: { items: [item, review], onOpen: (...args) => calls.push(args), onAdd() {} } });
    assert.match(screen.text(), /洗濯機/u); assert.match(screen.text(), /Panasonic NA-TEST（QA-1）/u);
    await screen.press('洗濯機、Panasonic NA-TEST（QA-1）のお手入れを開く（個人）');
    const status = screen.button('洗濯機、二階の洗濯機のお手入れを開く（グループ）');
    assert.equal(status.props.accessibilityValue.text, '確認が必要です');
    assert.match(screen.text(), /確認が必要です二階の洗濯機/u);
    assert.deepEqual(calls, [['personal', 'washer']]); assert.deepEqual(item, before);
  });
  test(`${platform} one appliance library opens personal and group items by scope even when their IDs match`, async () => {
    const calls = []; const row = { id: 'same-id', manufacturer: 'Maker', modelNumber: 'M1' };
    const screen = screenHarness('src/features/appliance-care/appliance-library.tsx', { exportName: 'ApplianceLibrary', platform, props: {
      joined: true, items: [{ ...row, source: 'personal', displayName: '自分の家電' }, { ...row, source: 'shared', displayName: '共有の家電' }],
      onOpen: (...args) => calls.push(args), onAdd() {},
    } });
    assert.match(screen.text(), /自分の家電/u); assert.match(screen.text(), /共有の家電/u); assert.match(screen.text(), /2台/u);
    await screen.press('自分の家電のお手入れを開く（個人）'); await screen.press('共有の家電のお手入れを開く（グループ）');
    assert.deepEqual(calls, [['personal', 'same-id'], ['shared', 'same-id']]);
    const list = screen.nodes().find(node => node.type === 'FlatList'); assert.equal(new Set(list.props.data.map(list.props.keyExtractor)).size, 2);
  });
  test(`${platform} adding a joined appliance opens PDF registration directly without product input or duplicate navigation`, async () => {
    const calls = []; let focused;
    const screen = screenHarness('src/features/appliance-care/appliance-library.tsx', { exportName: 'ApplianceLibrary', platform,
      effect: callback => callback(), navigationListener: (event, listener) => { if (event === 'focus') focused = listener; }, props: {
        joined: true, items: [], onOpen() {}, onAdd: (...args) => calls.push(args),
      } });
    const add = screen.button('家電を追加'); add.props.onPress(); add.props.onPress(); await screen.flush();
    assert.deepEqual(calls, [['shared']]);
    assert.equal(screen.nodes().some(node => node.type === 'TextInput' || node.type === 'Modal' || node.props.accessibilityRole === 'radio'), false);
    focused(); await screen.press('家電を追加'); assert.deepEqual(calls, [['shared'], ['shared']]);
  });
  test(`${platform} joined appliance navigation retains personal storage and opens PDF review without product input`, async () => {
    const navigation = []; const personal = { database: {}, snapshot: { appliances: [{ id: 'private', displayName: '自分の家電' }] }, refresh() {} };
    const active = { protocol: 2, groupId: 'group', userId: 'user', identity: { deviceId: 'device' } };
    const screen = screenHarness('src/features/sharing/v2-ui/workspace-route.tsx', { exportName: 'V2WorkspaceRoute', platform, props: { view: 'appliances' }, navigate: (...args) => navigation.push(args), mocks: {
      '../../../hooks/use-workspace': { useWorkspace: () => ({ ready: true, active, userId: 'user', group: { displayName: '家族' } }) },
      '../../../hooks/use-planner-data': { usePlannerData: options => { assert.equal(options.personal, true); return personal; } },
      './workspace-data': { useWorkspaceDisplay: () => ({ loadSession: async () => {}, subscribe: () => () => {}, peek: () => undefined }) },
      './group-screen': { V2GroupScreen: 'GroupScreen', readOptionsForView: () => ({ management: true, appliances: true }) },
    } });
    const props = screen.nodes().find(node => node.type === 'GroupScreen').props;
    assert.equal(props.personalGuide.snapshot, personal.snapshot);
    props.onPersonalAppliance('private'); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/manual/appliances/[id]', params: { id: 'private', returnTo: '/manual' } }]);
    assert.equal(props.onAddPersonalAppliance, undefined, 'a joined group has no second registration destination');
    props.onApplianceReview(); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/group-v2/appliance-review', params: {} }]);
  });
  test(`${platform} personal appliance detail and analysis always request the private planner while joined`, () => {
    const data = { database: {}, snapshot: { appliances: [], chores: [] }, refresh() {} }; let reads = 0;
    const mock = { usePlannerData: options => { assert.equal(options.personal, true); reads++; return data; } };
    for (const file of ['src/app/(tabs)/manual/appliances/[id]/index.tsx', 'src/app/(tabs)/manual/appliance-care.tsx']) {
      screenHarness(file, { platform, params: { id: 'private', returnTo: '/manual' }, mocks: { '@/hooks/use-planner-data': mock, '@/features/appliance-care/api-client': { analyzeApplianceCareRequest() { throw new Error('No paid API calls in screen tests'); } } } });
    }
    assert.equal(reads, 2);
  });
}
