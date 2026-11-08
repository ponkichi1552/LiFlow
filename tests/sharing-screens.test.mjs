import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { notificationWorkspace, isPlannerNotification } from '../src/features/notifications/workspace-response.ts';
import { sharedGoogleNamespace } from '../src/features/google-sync/workspace-policy.ts';

async function chooseFamily(screen) {
  const choice = screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '家族');
  assert.ok(choice); choice.props.onPress(); await screen.flush();
}

test('a cold group notification retries when the matching workspace opens after ready was already true',async()=>{
  const context={ready:true,userId:'owner',group:{userId:'owner',groupId:'group-test',status:'active'},active:null};let stored={actionIdentifier:'default',notification:{request:{identifier:'deferred-group',content:{data:{kind:'daily-housework-digest',workspace:sharedGoogleNamespace('owner','group-test')}}}}};
  const routes=[];const screen=screenHarness('src/components/notification-workspace-bridge.tsx',{exportName:'NotificationWorkspaceBridge',effectDependencies:true,effect:fn=>fn(),navigate:(...args)=>routes.push(args),mocks:{
    '@/hooks/use-workspace':{useWorkspace:()=>context},'expo-notifications':{addNotificationResponseReceivedListener:()=>({remove(){}}),getLastNotificationResponse:()=>stored,clearLastNotificationResponse:()=>{stored=null;}}}});
  try{await screen.flush();assert.equal(routes.length,0);context.active={userId:'owner',groupId:'group-test'};screen.render();await screen.flush();assert.deepEqual(routes,[['replace','/']]);assert.equal(stored,null);}
  finally{screen.unmount();}
});

test('sharing screen keeps login optional and exposes only the current group without switching or a second join', async () => {
  const calls = []; const group = { userId: 'owner', groupId: 'group-test', displayName: '家族', status: 'active' };
  const context = { active: null, userId: null, group: null, ready: true, refreshSharing: async () => {} };
  const screen = screenHarness('src/app/sharing/index.tsx', { layoutEffect: callback => callback(), navigate: (...args) => calls.push(['navigate', ...args]), mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => context },
    '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
    '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false,
      signInSharingWithGoogle: async () => { calls.push(['google']); context.userId = 'owner'; }, signOutSharing: async () => { calls.push(['logout']); context.userId = null; } },
    '@/platform/sharing/workspaces': { enableSharingSession: async () => {},
      createSharingWorkspace: () => assert.fail('normal new groups must not use the legacy creator'),
      createV2SharingWorkspace: async (name, kind) => { calls.push(['create', name, kind]); context.group = group; return group; },
      requestSharingWorkspace: async () => { assert.fail('creation must not join/import personal data'); },
      subscribeSharingChanges: () => () => {}, sharingFailureMessage: () => '通信を確認してください。' },
    'expo-image': { Image: 'Image' },
  } });
  assert.match(screen.text(), /個人の家事・予定は共有されません/); assert.equal(calls.length, 0);
  await screen.press('Googleで続ける'); assert.deepEqual(calls, [['google']]);
  assert.ok(screen.nodes().some(n => n.type === 'TextInput' && n.props.accessibilityLabel === '招待リンク'));
  assert.ok(!screen.nodes().some(n => n.type === 'TextInput' && n.props.accessibilityLabel === 'グループ名'));
  await screen.press('作成する'); await screen.change('グループ名', '家族'); await chooseFamily(screen); await screen.press('グループを作成');
  assert.ok(calls.some(call => call[0] === 'create' && call[1] === '家族' && call[2] === 'family'));
  assert.deepEqual(calls.at(-1), ['navigate', 'push', { pathname: '/sharing/group/[groupId]', params: { groupId: group.groupId } }]);
  assert.equal(screen.text().includes('グループを作る'), false);
  assert.equal(screen.text().includes('招待から参加する'), false);
  assert.equal(screen.text().includes('このグループを開く'), false);
  assert.equal(screen.text().includes('個人モードへ戻る'), false);
  await screen.press('グループを管理');
  assert.equal(context.group, group);
});


test('sharing screen prevents duplicate creation while the first local commit is still running and allows retry after failure', async () => {
  let release; let count = 0;
  const context = { active: null, userId: 'owner', group: null, ready: true, refreshSharing: async () => {} };
  const screen = screenHarness('src/app/sharing/index.tsx', { mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => context }, 'expo-image': { Image: 'Image' },
    '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
    '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false },
    '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingFailureMessage: () => '通信を確認してください。',
      createSharingWorkspace: () => assert.fail('normal new groups must not use the legacy creator'),
      createV2SharingWorkspace: async () => { count++; await new Promise((resolve) => { release = resolve; }); throw new Error('synthetic'); } },
  } });
  await screen.press('作成する'); await screen.change('グループ名', '家族');
  await chooseFamily(screen);
  const handler = screen.button('グループを作成').props.onPress;
  handler(); handler(); assert.equal(count, 1); release(); await screen.flush();
  assert.match(screen.text(), /通信を確認/); assert.equal(screen.button('グループを作成').props.disabled, false);
});

test('notification workspace lookup never crosses accounts, removed groups or unrelated notification types', () => {
  const data = { kind: 'daily-housework-digest', workspace: sharedGoogleNamespace('owner', 'group-test') };
  const groups = [{ userId: 'owner', groupId: 'group-test', status: 'active' }];
  assert.deepEqual(notificationWorkspace(data, 'owner', groups[0]), { userId: 'owner', groupId: 'group-test' });
  assert.equal(notificationWorkspace(data, 'other', groups[0]), undefined);
  assert.equal(notificationWorkspace(data, 'owner', { ...groups[0], status: 'removed' }), undefined);
  assert.equal(notificationWorkspace({ ...data, workspace: 'group-test' }, 'owner', groups[0]), undefined);
  assert.equal(notificationWorkspace({ kind: 'daily-housework-digest' }, null, null), null);
  assert.equal(notificationWorkspace({ kind: 'other' }, 'owner', groups[0]), undefined);
});

for (const platform of ['ios', 'android']) test(`${platform} a cold notification waits for secure workspace restoration and duplicate events navigate once without changing membership`, async () => {
  const events = []; let listener; let effect; let stored;
  const context = { ready: false, userId: 'owner', group: { userId: 'owner', groupId: 'group-test', status: 'active' }, active: { userId: 'owner', groupId: 'group-test' } };
  const refs = []; let index = 0;
  const { NotificationWorkspaceBridge } = loadNativeModule('src/components/notification-workspace-bridge.tsx', {
    react: { useRef: (value) => refs[index++] ??= { current: value }, useEffect: (callback) => { effect = callback; } },
    'expo-router': { router: { replace: (route) => events.push(['route', route]) } },
    '@/hooks/use-workspace': { useWorkspace: () => context }, '@/features/notifications/workspace-response': { notificationWorkspace, isPlannerNotification },
    'expo-notifications': { addNotificationResponseReceivedListener: (callback) => { listener = callback; return { remove: () => events.push(['remove']) }; },
      getLastNotificationResponse: () => stored, clearLastNotificationResponse: () => { stored = null; events.push(['clear']); } },
  });
  stored = { actionIdentifier: 'default', notification: { request: { identifier: 'group-notification', content: { data: { kind: 'daily-housework-digest',
    workspace: sharedGoogleNamespace('owner', 'group-test') } } } } };
  NotificationWorkspaceBridge(); assert.equal(effect(), undefined); assert.deepEqual(events, []);
  context.ready = true; index = 0; NotificationWorkspaceBridge(); const cleanup = effect(); listener(stored); listener(stored);
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(events, [['route', '/'], ['clear']]);
  cleanup(); assert.deepEqual(events.at(-1), ['remove']);
});
