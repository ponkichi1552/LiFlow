import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarPairingStorage } from '../../../platform/storage/private-calendar-pairing.ts';
import type { createPrivateCalendarAuthorityIntentStorage } from '../../../platform/storage/private-calendar-authority-intents.ts';
import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import type { createPrivateCalendarAuthoritySync } from './authority-sync.ts';
import { collectPrivateCalendarAuthorityHistory } from './authority-sync.ts';
import type { createPrivateCalendarKeyDelivery } from './key-delivery.ts';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from './pairing.ts';
import { privateCalendarPairingApproval, snapshotPrivateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from './pairing.ts';
import { verifyPrivateCalendarRoot } from './authority.ts';
import type { VerifiedPrivateCalendarAuthority } from './authority.ts';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { assertPrivateCalendarWork, privateCalendarWork } from './sync-deadline.ts';
import type { PrivateCalendarWorkControl } from './sync-deadline.ts';

type Cloud = Pick<ReturnType<typeof createPrivateCalendarCloud>, 'authorityPage' | 'readKey'>;
export function createPrivateCalendarPairingController(port: { userId: string; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  candidates: ReturnType<typeof createPrivateCalendarPairingStorage>; intents: ReturnType<typeof createPrivateCalendarAuthorityIntentStorage>;
  authoritySync: ReturnType<typeof createPrivateCalendarAuthoritySync>; delivery: ReturnType<typeof createPrivateCalendarKeyDelivery>; cloud: Cloud }) {
  const { userId, secrets, candidates, intents, authoritySync, delivery, cloud } = port; assertSharedIdentifier(userId);
  async function readPinnedHistory(reference: PrivateCalendarPairingReference, control: PrivateCalendarWorkControl = {}) {
    if (reference.anchor.ownerUserId !== userId) throw new Error('確認した本人用アカウントが異なります。');
    const page = await privateCalendarWork(() => cloud.authorityPage(0, control.assertBudget), control); if (!page?.authorities[0]) throw new Error('本人端末の署名履歴がありません。');
    const root = verifyPrivateCalendarRoot(page.authorities[0], reference.anchor);
    return collectPrivateCalendarAuthorityHistory(cloud, root, page, control);
  }
  return {
    /** The caller supplies either a confirmed reference or a signed one-time grant verified against this authority. */
    async prepareConfirmedReference(reference: PrivateCalendarPairingReference, verifyGrant?: (authority: VerifiedPrivateCalendarAuthority) => void | Promise<void>, control: PrivateCalendarWorkControl = {}) {
      assertPrivateCalendarWork(control);
      const owned = snapshotPrivateCalendarPairingReference(reference);
      if (owned.anchor.ownerUserId !== userId) throw new Error('確認した本人用アカウントが異なります。');
      const known = await secrets.authority(userId);
      if (known && (known.anchor.rootDigest !== owned.anchor.rootDigest || known.anchor.accountGeneration !== owned.anchor.accountGeneration)) throw new Error('確認済みの信頼pinを自動で置き換えません。復旧を確認してください。');
      const checked = known ? await authoritySync.refresh(control) : await readPinnedHistory(owned, control);
      if (checked.authority.digest !== owned.authorityDigest || checked.authority.signed.body.revision !== owned.authorityRevision) throw new Error('確認元の端末設定が古くなっています。新しい確認情報を交換してください。');
      await verifyGrant?.(checked.authority);
      assertPrivateCalendarWork(control);
      return candidates.prepare(owned, await secrets.identity(userId));
    },
    /** A manual approval or a verified one-use capability is required before entering this method. */
    async approve(request: PrivateCalendarPairingRequest, control: PrivateCalendarWorkControl = {},
      authorizeConnection?: (checked: Awaited<ReturnType<typeof authoritySync.refresh>>) => void) {
      assertPrivateCalendarWork(control);
      const owned = verifyPrivateCalendarPairingRequest(request); const body = owned.body;
      if (body.ownerUserId !== userId) throw new Error('本人用の別アカウントの端末は承認できません。');
      for (let attempt = 0; attempt < 3; attempt++) {
        assertPrivateCalendarWork(control);
        const pending = await intents.readPending();
        if (pending) {
          const context = authorizeConnection ? await authoritySync.refresh(control) : null;
          if (context) authorizeConnection!(context);
          const proposed = pending.signed.body;
          const predecessor = context?.history[proposed.revision - 2];
          const before = predecessor?.body ?? pending.current.signed.body;
          const onlyAddsRecipient = pending.rootDigest === body.rootDigest && before.keyVersion === proposed.keyVersion
            && (!context || predecessor && sharedDocumentDigest(predecessor) === proposed.previousDigest)
            && before.mainDeviceId === proposed.mainDeviceId && !before.devices.some(device => device.deviceId === body.device.deviceId)
            && canonicalJson(proposed.devices) === canonicalJson([...before.devices, body.device].sort((a, b) => a.deviceId.localeCompare(b.deviceId)));
          const belongsToRequest = pending.rootDigest === body.rootDigest && proposed.previousDigest === body.authorityDigest
            && proposed.devices.some(device => canonicalJson(device) === canonicalJson(body.device));
          if (authorizeConnection ? !onlyAddsRecipient : !belongsToRequest) throw new Error('別の本人端末の変更が送信待ちです。元の変更を先に確認してください。');
          const resumed = await authoritySync.resume(control);
          if (resumed.kind === 'review') {
            if (!authorizeConnection) return resumed;
            const latest = await authoritySync.refresh(control); authorizeConnection(latest); assertPrivateCalendarWork(control);
            // Only this capability's pure device addition is rebased. Main/revocation/key changes are never discarded.
            if (!await authoritySync.dismissReviewed(resumed.intentDigest, latest.authority.digest)) throw new Error('接続中に端末設定が更新されました。再試行してください。');
          }
        }
        const checked = await authoritySync.refresh(control); const current = checked.authority;
        if (current.anchor.rootDigest !== body.rootDigest || current.anchor.accountGeneration !== body.accountGeneration
          || !checked.history[body.authorityRevision - 1] || sharedDocumentDigest(checked.history[body.authorityRevision - 1]) !== body.authorityDigest) throw new Error('確認依頼の信頼pin・元の端末設定が異なります。');
        const approved = current.signed.body.devices.some(device => canonicalJson(device) === canonicalJson(body.device));
        authorizeConnection?.(checked);
        if (!approved) {
          assertPrivateCalendarWork(control);
          const change = authorizeConnection ? { devices: [...current.signed.body.devices, body.device], mainDeviceId: current.signed.body.mainDeviceId, keyVersion: current.signed.body.keyVersion }
            : privateCalendarPairingApproval(owned, current).change;
          const result = await authoritySync.change(change, control);
          if (result.kind === 'review') { if (!authorizeConnection) return result; continue; }
        }
        const queued = await delivery.queueApprovedDevices(control); const sent = await delivery.flush({ ...control, force: true });
        return { kind: 'approved' as const, deviceId: body.device.deviceId, queued, delivery: sent };
      }
      throw new Error('端末設定の変更が重なっています。接続内容は保持しているので再試行してください。');
    },
    async join(control: PrivateCalendarWorkControl = {}) {
      assertPrivateCalendarWork(control);
      const candidate = await candidates.read(); if (!candidate) throw new Error('確認した本人端末の情報を先に準備してください。');
      const body = candidate.request.body;
      const reference = snapshotPrivateCalendarPairingReference({ anchor: { ownerUserId: body.ownerUserId, accountGeneration: body.accountGeneration, rootDigest: body.rootDigest },
        authorityDigest: body.authorityDigest, authorityRevision: body.authorityRevision });
      const existing = await secrets.authority(userId);
      const checked = existing ? await authoritySync.refresh(control) : await readPinnedHistory(reference, control); const current = checked.authority;
      if (!checked.history[body.authorityRevision - 1] || sharedDocumentDigest(checked.history[body.authorityRevision - 1]) !== body.authorityDigest
        || !current.signed.body.devices.some(device => canonicalJson(device) === canonicalJson(body.device))) throw new Error('この本人端末の承認がまだないか、承認が解除されています。');
      assertPrivateCalendarWork(control); if (!existing) await secrets.confirmTrust(userId, current, 'approvedPairing');
      if (!await candidates.markApproved(sharedDocumentDigest(candidate.request))) throw new Error('本人端末の確認情報が更新されています。');
      let key = await secrets.currentKey(userId, current);
      try {
        if (!key) {
          // Only the generation's signed issuer may create it; other devices remain awaiting delivery.
          await delivery.queueApprovedDevices(control); key = await secrets.currentKey(userId, current);
        }
        if (!key) {
          const wrapped = await privateCalendarWork(() => cloud.readKey(current, body.device.deviceId, control.assertBudget), control);
          if (wrapped) { await secrets.receiveCurrentKey(userId, current, wrapped); key = await secrets.currentKey(userId, current); }
        }
        return { kind: key ? 'ready' as const : 'awaitingKey' as const, deviceId: body.device.deviceId, authorityDigest: current.digest };
      } finally { key?.fill(0); }
    },
  };
}
