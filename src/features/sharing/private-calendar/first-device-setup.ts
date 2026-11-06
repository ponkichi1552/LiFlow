import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarRootSetupStorage } from '../../../platform/storage/private-calendar-root-setup.ts';
import type { PrivateCalendarCloudHead } from './cloud-contract.ts';
import { assertPrivateCalendarCloudAuthority } from './cloud-contract.ts';
import type { VerifiedPrivateCalendarAuthority } from './authority.ts';
import { verifyPrivateCalendarRoot } from './authority.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { assertPrivateCalendarWork, privateCalendarWork } from './sync-deadline.ts';
import type { PrivateCalendarWorkControl } from './sync-deadline.ts';

export interface PrivateCalendarFirstDeviceSetupPort {
  readonly userId: string; readonly secrets: ReturnType<typeof createPrivateCalendarSecretStore>; readonly intents: ReturnType<typeof createPrivateCalendarRootSetupStorage>;
  readonly cloud: { createRoot(authority: VerifiedPrivateCalendarAuthority, checkBudget?: () => void): Promise<{ head: PrivateCalendarCloudHead }> };
}
/** Call only for an explicit first-device choice. No formal pin or data key is generated before server acceptance. */
export function createPrivateCalendarFirstDeviceSetup(port: PrivateCalendarFirstDeviceSetupPort) {
  const { userId, secrets, intents, cloud } = port; assertSharedIdentifier(userId);
  async function resume(control: PrivateCalendarWorkControl = {}) {
    assertPrivateCalendarWork(control);
    const intent = await intents.read(); if (!intent) throw new Error('本人端末の初回設定を先に準備してください。');
    if (intent.signed.body.ownerUserId !== userId) throw new Error('初回設定のアカウントが異なります。');
    if (intent.status === 'ready') return { kind: 'ready' as const, rootDigest: intent.digest };
    const root = verifyPrivateCalendarRoot(intent.signed, { ownerUserId: userId, accountGeneration: intent.signed.body.accountGeneration, rootDigest: intent.digest });
    const accepted = await privateCalendarWork(() => cloud.createRoot(root, control.assertBudget), control); assertPrivateCalendarCloudAuthority(accepted.head, root);
    assertPrivateCalendarWork(control);
    await secrets.confirmTrust(userId, root, 'firstDeviceSetup');
    let key = await secrets.currentKey(userId, root);
    try {
      assertPrivateCalendarWork(control);
      key ??= await secrets.createCurrentKey(userId, root);
      assertPrivateCalendarWork(control);
      if (!await intents.markReady(root.digest)) throw new Error('本人端末の設定が更新されています。初回設定を再確認してください。');
      return { kind: 'ready' as const, rootDigest: root.digest };
    } finally { key?.fill(0); }
  }
  return {
    async prepareAndResume() {
      const identity = await secrets.identity(userId); await intents.prepare(identity); return resume();
    },
    resume,
  };
}
