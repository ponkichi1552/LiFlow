import type { SharingCryptoGateway } from '../crypto.ts';
import { canonicalJson } from '../operations.ts';
import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarPairingController } from './pairing-controller.ts';
import type { createPrivateCalendarAuthoritySync } from './authority-sync.ts';
import type { createPrivateCalendarConnectionStorage } from '../../../platform/storage/private-calendar-connections.ts';
import type { createPrivateCalendarConnectionCloud } from '../../../platform/sharing/private-calendar-connection-cloud.ts';
import { connectionClaim, connectionRequestDigest, createConnectionCode, decodeConnectionCode, verifyConnectionClaim, verifyConnectionGrant } from './connection-code.ts';
import type { PrivateCalendarConnectionRecord } from './connection-code.ts';
import { assertPrivateCalendarWork, privateCalendarWork } from './sync-deadline.ts';
import type { PrivateCalendarWorkControl } from './sync-deadline.ts';
import { verifyPrivateCalendarRoot, verifyPrivateCalendarAuthorityUpdate } from './authority.ts';
import type { VerifiedPrivateCalendarAuthority } from './authority.ts';

export interface PrivateCalendarConnectionPort {
  store: ReturnType<typeof createPrivateCalendarConnectionStorage>;
  cloud: ReturnType<typeof createPrivateCalendarConnectionCloud>;
  crypto: SharingCryptoGateway;
  now?: () => number;
}
export function createPrivateCalendarConnectionController(port: PrivateCalendarConnectionPort & {
  userId: string; assertOwner(): void | Promise<void>; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  pairing: ReturnType<typeof createPrivateCalendarPairingController>; authoritySync: ReturnType<typeof createPrivateCalendarAuthoritySync>;
  beforePairing?(authority: VerifiedPrivateCalendarAuthority, control: PrivateCalendarWorkControl): Promise<void>;
}) {
  const { userId, secrets, store, cloud, pairing, authoritySync, now = Date.now } = port;
  async function record(codeText: string, control: PrivateCalendarWorkControl = {}) {
    const code = decodeConnectionCode(codeText); await port.assertOwner();
    const remote = await privateCalendarWork(() => cloud.read(code.grant.body.codeId, control.assertBudget), control); await port.assertOwner();
    if (!remote || canonicalJson(remote.grant) !== canonicalJson(code.grant)) throw new Error('接続コードが見つからないか、発行元が異なります。');
    return { code, remote };
  }
  function sameClaim(remote: PrivateCalendarConnectionRecord, codeText: string) {
    if (!remote.claim) throw new Error('接続する端末がありません。');
    return verifyConnectionClaim(decodeConnectionCode(codeText), remote.claim);
  }
  function authorize(code: ReturnType<typeof decodeConnectionCode>, checked: Awaited<ReturnType<typeof authoritySync.refresh>>, at: number,
    request: ReturnType<typeof verifyConnectionClaim>['request']) {
    const ref = code.grant.body.reference;
    if (!checked.history.length) throw new Error('接続元の署名履歴がありません。');
    let base = verifyPrivateCalendarRoot(checked.history[0], ref.anchor);
    for (let index = 1; index < ref.authorityRevision; index++) base = verifyPrivateCalendarAuthorityUpdate(base, checked.history[index]);
    verifyConnectionGrant(code.grant, base, userId, at);
    const issuer = base.signed.body.devices.find(device => device.deviceId === code.grant.body.issuerDeviceId)!;
    let recipientSeen = false;
    for (const signed of checked.history.slice(ref.authorityRevision - 1)) {
      if (!signed.body.devices.some(device => canonicalJson(device) === canonicalJson(issuer))) throw new Error('接続元の端末は解除されています。');
      const recipient = signed.body.devices.find(device => device.deviceId === request.body.device.deviceId);
      if (recipient && canonicalJson(recipient) !== canonicalJson(request.body.device) || recipientSeen && !recipient) throw new Error('接続する端末は解除されています。新しいコードを受け取ってください。');
      recipientSeen ||= Boolean(recipient);
    }
  }
  return {
    async issue(control: PrivateCalendarWorkControl = {}) {
      await port.assertOwner(); const { authority } = await authoritySync.refresh(control);
      const device = await secrets.publicState(userId);
      if (!device?.hasCurrentKey || !authority.signed.body.devices.some(row => row.deviceId === device.identity.deviceId)) throw new Error('この端末の同期設定を先に完了してください。');
      const before = await store.read();
      if (before.state.issued?.acceptedRequestDigest) throw new Error('接続中の端末があります。完了後に新しいコードを発行できます。');
      let codeText = before.state.issued?.code;
      if (codeText) {
        try { verifyConnectionGrant(decodeConnectionCode(codeText).grant, authority, userId, now()); }
        catch { codeText = undefined; }
      }
      if (!codeText) {
        codeText = await createConnectionCode(port.crypto, authority, await secrets.identity(userId), now());
        await store.save(before.revision, { ...before.state, issued: { code: codeText, acceptedRequestDigest: null } });
      }
      await privateCalendarWork(() => cloud.create(decodeConnectionCode(codeText!).grant, control.assertBudget), control); await port.assertOwner(); return codeText;
    },
    async connect(text: string, control: PrivateCalendarWorkControl = {}) {
      await port.assertOwner(); const code = decodeConnectionCode(text), b = code.grant.body;
      if (b.reference.anchor.ownerUserId !== userId || b.expiresAt <= now()) throw new Error('同じアカウントの有効な接続コードを使ってください。');
      const before = await store.read();
      if (before.state.joining?.code === text.trim()) {
        await privateCalendarWork(() => cloud.claim(code.grant, connectionClaim(code, before.state.joining!.request), control.assertBudget), control); return;
      }
      if (before.state.joining && decodeConnectionCode(before.state.joining.code).grant.body.expiresAt > now()) throw new Error('別の端末との接続を処理中です。');
      const candidate = await pairing.prepareConfirmedReference(b.reference, async authority => {
        verifyConnectionGrant(code.grant, authority, userId, now());
        await port.beforePairing?.(authority, control);
      }, control);
      await store.save(before.revision, { ...before.state, joining: { code: text.trim(), request: candidate.request } });
      await privateCalendarWork(() => cloud.claim(code.grant, connectionClaim(code, candidate.request), control.assertBudget), control); await port.assertOwner();
    },
    async synchronize(control: PrivateCalendarWorkControl = {}) {
      assertPrivateCalendarWork(control); await port.assertOwner();
      let saved = await store.read(); const issued = saved.state.issued;
      if (issued) {
        const decoded = decodeConnectionCode(issued.code);
        if (!issued.acceptedRequestDigest && decoded.grant.body.expiresAt <= now()) {
          saved = await store.save(saved.revision, { ...saved.state, issued: null });
        } else {
          assertPrivateCalendarWork(control); const { code, remote } = await record(issued.code, control); assertPrivateCalendarWork(control);
          if (remote.claim) {
            const claim = sameClaim(remote, issued.code), digest = connectionRequestDigest(claim);
            if (issued.acceptedRequestDigest && issued.acceptedRequestDigest !== digest) throw new Error('接続する端末が更新されています。');
            if (!issued.acceptedRequestDigest) {
              const state = await secrets.publicState(userId);
              const checked = await authoritySync.refresh(control);
              authorize(code, checked, now(), claim.request);
              if (state?.identity.deviceId !== code.grant.body.issuerDeviceId) throw new Error('コードを発行した端末で接続を再開してください。');
              saved = await store.save(saved.revision, { ...saved.state, issued: { ...issued, acceptedRequestDigest: digest } });
            }
            assertPrivateCalendarWork(control);
            // Issuing this single-use capability was the user's approval. Only its proven recipient is authorized here.
            const result = await pairing.approve(claim.request, control, checked => authorize(code, checked,
              code.grant.body.issuedAt, claim.request)); assertPrivateCalendarWork(control);
            if (result.kind === 'approved' && result.delivery.kind === 'sent') {
              await privateCalendarWork(() => cloud.complete(code.grant, digest, control.assertBudget), control); assertPrivateCalendarWork(control);
              saved = await store.save(saved.revision, { ...saved.state, issued: null });
            }
          }
        }
      }
      const joining = saved.state.joining;
      if (joining) {
        assertPrivateCalendarWork(control); const { remote } = await record(joining.code, control); assertPrivateCalendarWork(control);
        if (remote.claim) {
          const claim = sameClaim(remote, joining.code);
          if (canonicalJson(claim.request) !== canonicalJson(joining.request)) throw new Error('この接続コードは別の端末で使用されています。');
          if (remote.state === 'complete') {
            const joined = await pairing.join(control); assertPrivateCalendarWork(control);
            if (joined.kind === 'ready') await store.save(saved.revision, { ...saved.state, joining: null });
          }
        }
      }
      await port.assertOwner();
    },
    async pending() {
      const { state } = await store.read();
      return [state.issued?.code, state.joining?.code].filter((value): value is string => Boolean(value))
        .map(value => { const { body } = decodeConnectionCode(value).grant; return { id: body.codeId, expiresAt: body.expiresAt }; });
    },
    watch: cloud.watch,
  };
}
