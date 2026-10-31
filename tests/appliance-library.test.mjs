import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) {
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
  test(`${platform} adding an appliance defaults to personal and shares only after choosing the group`, async () => {
    const calls = []; const screen = screenHarness('src/features/appliance-care/appliance-library.tsx', { exportName: 'ApplianceLibrary', platform, props: {
      joined: true, items: [], addSources: ['personal', 'shared'], onOpen() {}, onAdd: (...args) => calls.push(args),
    } });
    const radio = label => { const node = screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === label); assert.ok(node); return node; };
    await screen.press('家電を追加'); assert.equal(radio('個人用に追加').props.accessibilityState.checked, true);
    await screen.press('次へ'); assert.match(screen.text(), /製品名を入力/u); assert.deepEqual(calls, []);
    await screen.change('家電の製品名', '自分の掃除機'); await screen.press('次へ'); assert.deepEqual(calls, [['personal', '自分の掃除機']]);
    await screen.press('家電を追加'); await radio('グループ共通に追加').props.onPress(); await screen.flush(); await screen.change('家電の製品名', '共有の洗濯機');
    const next = screen.button('次へ'); next.props.onPress(); next.props.onPress(); await screen.flush();
    assert.deepEqual(calls.at(-1), ['shared', '共有の洗濯機']); assert.equal(calls.length, 2);
    await screen.press('家電を追加'); assert.equal(radio('個人用に追加').props.accessibilityState.checked, true);
    await screen.press('キャンセル'); assert.equal(calls.length, 2);
  });
  test(`${platform} joined appliance navigation retains personal storage and passes a new shared product name into review`, async () => {
    const navigation = []; const personal = { database: {}, snapshot: { appliances: [{ id: 'private', displayName: '自分の家電' }] }, refresh() {} };
    const active = { protocol: 2, groupId: 'group', userId: 'user', identity: { deviceId: 'device' } };
    const screen = screenHarness('src/features/sharing/v2-ui/workspace-route.tsx', { exportName: 'V2WorkspaceRoute', platform, props: { view: 'appliances' }, navigate: (...args) => navigation.push(args), mocks: {
      '../../../hooks/use-workspace': { useWorkspace: () => ({ ready: true, active, userId: 'user', group: { displayName: '家族' } }) },
      '../../../hooks/use-planner-data': { usePlannerData: options => { assert.equal(options.personal, true); return personal; } },
      './group-screen': { V2GroupScreen: 'GroupScreen' },
    } });
    const props = screen.nodes().find(node => node.type === 'GroupScreen').props;
    assert.equal(props.personalGuide.snapshot, personal.snapshot);
    props.onPersonalAppliance('private'); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/manual/appliances/[id]', params: { id: 'private', returnTo: '/manual' } }]);
    props.onAddPersonalAppliance('自分の掃除機'); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/manual/appliance-care', params: { productName: '自分の掃除機', returnTo: '/manual' } }]);
    props.onApplianceReview(undefined, '共有の洗濯機'); assert.deepEqual(navigation.at(-1), ['push', { pathname: '/group-v2/appliance-review', params: { productName: '共有の洗濯機' } }]);
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
