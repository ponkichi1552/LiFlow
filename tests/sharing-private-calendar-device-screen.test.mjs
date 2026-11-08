import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarDeviceSession } from '../src/features/sharing/private-calendar/device-session.ts';
import { createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { createConnectionCode, decodeConnectionCode } from '../src/features/sharing/private-calendar/connection-code.ts';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';

const userId = 'device-screen-owner';
function settings(t, h) {
  const f = privateCalendarSetupFixture(t, { userId }); const session = createPrivateCalendarDeviceSession({ userId,
    assertOwner: () => assert.equal(f.state.currentUser, userId, 'owner changed'), secrets: f.secrets, roots: f.roots, intents: f.changes,
    candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud: h.cloud, connections: { store: f.connections, cloud: h.connectionCloud, crypto: f.gateway } }); return { ...f, session };
}
async function open(session, platform, embedded = false, operation = null) {
  let mount; const shared = []; let backs = 0;
  const screen = screenHarness('src/features/sharing/private-calendar/device-screen.tsx', { exportName: 'PrivateCalendarDeviceScreen', platform,
    effect: callback => { mount ??= callback; }, props: { embedded, loadSession: async () => session, onBack: () => { backs++; }, onShare: async value => { shared.push(structuredClone(value)); } },
    mocks: operation ? { '../../settings/account-operation': { useAccountOperation: () => operation } } : {} });
  const cleanup = mount();
  for (let n = 0; n < 30 && screen.nodes().some(node => node.type === 'ActivityIndicator'); n++) await screen.flush();
  assert.equal(screen.nodes().some(node => node.type === 'ActivityIndicator'), false);
  return { screen, shared, backs: () => backs, close: cleanup };
}

for (const platform of ['ios','android']) {
  test(`${platform} embedded device mutations share the account lock through failure and unmount`, async t => {
    const h = privateCalendarMemoryCloud(); const f = settings(t, h); let busy = false; let releases = 0; let resolve;
    const operation = { get busy() { return busy; }, acquire() { if (busy) return false; busy = true; return true; }, release() { busy = false; releases++; } };
    let calls = 0; let fail = true; const session = { ...f.session, initializeFirstDevice: async () => {
      calls++; if (fail) throw new Error('synthetic first-device failure');
      await new Promise(done => { resolve = done; }); return f.session.initializeFirstDevice();
    } };
    const ui = await open(session, platform, true, operation); t.after(ui.close);
    const confirm = ui.screen.button('同期を設定する').props.onPress;
    busy = true; ui.screen.render(); await confirm(); assert.equal(releases, 0); assert.equal(calls, 0); assert.equal(h.history.length, 0);
    busy = false; ui.screen.render(); await confirm(); await ui.screen.flush(); assert.equal(busy, false); assert.equal(releases, 1);
    fail = false;
    const pending = confirm(); await ui.screen.flush(); await confirm();
    assert.equal(calls, 2); assert.equal(busy, true); ui.close(); assert.equal(busy, true);
    resolve(); await pending; assert.equal(busy, false); assert.equal(releases, 2); assert.equal(h.history.length, 1);
  });

  test(`${platform} private device setup choices retain pasted information and never create trust while browsing`, async t => {
    const h = privateCalendarMemoryCloud(); const f = settings(t, h); const ui = await open(f.session, platform); t.after(ui.close);
    const field = () => ui.screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '端末の接続コード');
    assert.equal(field(), undefined);
    await ui.screen.press('端末を追加'); await ui.screen.change('端末の接続コード', '{"draft":"not yet verified"}');
    await ui.screen.press('初めて設定'); assert.equal(field(), undefined);
    await ui.screen.press('端末を追加'); assert.equal(field().props.value, '{"draft":"not yet verified"}');
    assert.equal(f.state.generations, 0); assert.equal(h.history.length, 0); assert.equal(f.values.size, 0);
  });

  test(`${platform} private device settings initialize only on an explicit setup action and share a single-use code`, async t => {
    const h = privateCalendarMemoryCloud(); const f = settings(t, h); const ui = await open(f.session, platform); t.after(ui.close);
    ui.screen.button('初めて設定'); assert.equal(f.state.generations, 0); assert.equal(h.history.length, 0);
    await ui.screen.press('同期を設定する'); assert.equal(h.history.length, 1); assert.match(ui.screen.text(), /接続済み/u);
    await ui.screen.press('接続コードを共有');
    assert.equal(ui.shared.length, 1); assert.equal(decodeConnectionCode(ui.shared[0]).grant.body.reference.anchor.ownerUserId, userId);
    assert.equal(JSON.stringify(ui.shared).includes('SecretKey'), false);
  });

  test(`${platform} private device settings connect from a code automatically and keep pending key delivery distinct from success`, async t => {
    const h = privateCalendarMemoryCloud(); const a = settings(t, h), b = settings(t, h); await a.session.initializeFirstDevice();
    const recipient = await open(b.session, platform, true), owner = await open(a.session, platform, true); t.after(recipient.close); t.after(owner.close);
    await owner.screen.press('接続コードを共有'); h.flags.keyBlocked = true;
    await recipient.screen.press('端末を追加'); await recipient.screen.change('端末の接続コード', owner.shared[0]);
    for (let n = 0; n < 30 && (await a.session.read()).pendingKeys === 0; n++) { await owner.screen.flush(); await recipient.screen.flush(); }
    assert.equal((await b.session.read()).keyReady, false); assert.equal((await a.session.read()).pendingKeys, 1);
    assert.match(recipient.screen.text(), /応答待ち/u); assert.doesNotMatch(recipient.screen.text(), /接続済み/u);
    for (let n = 0; n < 30 && !owner.screen.nodes().some(node => node.props.accessibilityLabel === '端末設定を同期'); n++) await owner.screen.flush();
    h.flags.keyBlocked = false; await owner.screen.press('端末設定を同期');
    for (let n = 0; n < 50 && !(await b.session.read()).keyReady; n++) { await owner.screen.flush(); await recipient.screen.flush(); }
    await recipient.screen.flush(); assert.equal((await b.session.read()).keyReady, true); assert.match(recipient.screen.text(), /接続済み/u); assert.equal(h.history.length, 2);
  });

  test(`${platform} private device settings reject malformed foreign and oversized information without creating a device`, async t => {
    const h=privateCalendarMemoryCloud(); const f=settings(t,h); const ui=await open(f.session,platform); t.after(ui.close);
    await ui.screen.press('端末を追加');
    const identity = await createDeviceIdentity(sharingTestCrypto); const foreign = await createConnectionCode(sharingTestCrypto, await createPrivateCalendarRoot(sharingTestCrypto, 'foreign-owner', identity), identity, Date.now());
    for (const value of ['{bad',foreign,'x'.repeat(8001)]) {
      await ui.screen.change('端末の接続コード',value); await ui.screen.press('同期する');
      assert.match(ui.screen.text(),/接続を完了できませんでした/u); assert.equal(f.state.generations,0); assert.equal(h.history.length,0);
      assert.ok(!ui.screen.nodes().some(node=>node.props.accessibilityRole==='button'&&node.children?.includes('照合した情報で依頼を作成')));
    }
  });

  test(`${platform} private device settings require another confirmation for revocation and retain the removed device records`, async t=>{
    const h=privateCalendarMemoryCloud(); const a=settings(t,h); const b=settings(t,h); const initial=await a.session.initializeFirstDevice();
    const prepared=await b.session.prepareConfirmedReference(initial.reference); await a.session.approveConfirmedRequest(prepared.request); await b.session.acceptApproval();
    const ui=await open(a.session,platform); t.after(ui.close); const label=`端末 ${prepared.deviceId.slice(7,15)}の承認を解除`;
    await ui.screen.press(label); assert.equal(h.history.length,2); assert.match(ui.screen.text(),/過去の端末保存データは削除しません/u);
    await ui.screen.press('確認して実行'); assert.equal(h.history.length,3); assert.equal((await a.session.read()).keyVersion,2);
    assert.equal((await b.session.synchronizeDevices()).phase,'revoked'); assert.equal((await b.readProtected()).hasStoredKeys,true);
  });

  test(`${platform} closing private device settings before session initialization prevents late protected reads and queued actions`, async()=>{
    let resolve; let mount; let reads=0;
    const waiting=new Promise(done=>{resolve=done;});
    const screen=screenHarness('src/features/sharing/private-calendar/device-screen.tsx',{exportName:'PrivateCalendarDeviceScreen',platform,
      effect:callback=>{mount??=callback;},props:{loadSession:()=>waiting,onBack(){},onShare:async()=>{}}});
    const cleanup=mount();const queued=screen.button('端末内の設定を再読込').props.onPress;cleanup();resolve({read:async()=>{reads++;throw new Error('must not read');}});
    await screen.flush();await queued();assert.equal(reads,0);assert.equal(screen.button('端末内の設定を再読込').props.disabled,true);
  });

  test(`${platform} private device setup retains a retry after failed initial read without creating trust`, async t => {
    const h = privateCalendarMemoryCloud(); const f = settings(t, h); let fail = true;
    const session = { ...f.session, read: async () => { if (fail) throw new Error('synthetic initial read failure'); return f.session.read(); } };
    const ui = await open(session, platform, true); t.after(ui.close);
    assert.match(ui.screen.text(), /読み込めませんでした/u); assert.equal(f.state.generations, 0);
    fail = false; await ui.screen.press('端末内の設定を再読込'); ui.screen.button('同期を設定する');
    assert.equal(f.state.generations, 0); assert.equal(h.history.length, 0); assert.equal(f.values.size, 0);
  });
}

test('private device route requires authenticated ownership before opening any Native service and links back to sharing login', async()=>{
  let opens=0; const moves=[]; const context={ready:true,userId:null}; const screen=screenHarness('src/app/sharing/private-calendar.tsx',{mocks:{
    '../../hooks/use-workspace':{useWorkspace:()=>context}, '../../platform/sharing/private-calendar-devices':{openPrivateCalendarDevices:()=>{opens++;throw new Error('must not open');}},
  },navigate:(...args)=>moves.push(args)});
  assert.equal(opens,0); await screen.press('共有用アカウントへ'); assert.deepEqual(moves.at(-1),['replace','/sharing']);
});

test('private device setup guidance remains available in app help without composing a native session', () => {
  const help = screenHarness('src/app/help.tsx', { params: { section: '端末間同期' } });
  help.button('端末間同期を閉じる'); assert.match(help.text(), /接続コードを共有/u); assert.match(help.text(), /同期を設定する/u);
  assert.match(help.text(), /10分間有効で、1台だけ/u); assert.match(help.text(), /元の端末で追加承認する操作は不要/u);
});
