import type { createPrivateCalendarSourceStorage, PrivateCalendarSourceChoice } from '../../../platform/storage/private-calendar-source.ts';
import type { createPrivateCalendarAuthorityIntentStorage } from '../../../platform/storage/private-calendar-authority-intents.ts';
import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarAuthoritySync } from './authority-sync.ts';
import type { SignedPrivateCalendarAuthority, VerifiedPrivateCalendarAuthority } from './authority.ts';
import { advancePrivateCalendarAuthority, samePrivateCalendarAuthorityConfiguration } from './authority.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { exactRecord, hexBytes } from './validation.ts';
import { assertPrivateCalendarAuthorityAppend } from './authority-history-limits.ts';

/** Source epochs are the signed transitions with unchanged device, main and key configuration. */
function latestSourceDigest(history: readonly SignedPrivateCalendarAuthority[]) {
  let digest: string | null = null;
  for (let index = 1; index < history.length; index++) {
    const previous = history[index - 1].body; const next = history[index].body;
    if (samePrivateCalendarAuthorityConfiguration(previous, next)) digest = sharedDocumentDigest(history[index]);
  }
  return digest;
}

/** Opaque transport generation, independent of any Google subject and shared-group inputs.
 * Every authority revision invalidates old cache already; an explicit source switch also advances it. */
export function privateCalendarSourceBinding(authority: VerifiedPrivateCalendarAuthority): string {
  hexBytes(authority.digest, 32); return `source-${authority.digest}`;
}
export function createPrivateCalendarSourceController(port: { userId: string; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  source: ReturnType<typeof createPrivateCalendarSourceStorage>; intents: ReturnType<typeof createPrivateCalendarAuthorityIntentStorage>;
  authoritySync: ReturnType<typeof createPrivateCalendarAuthoritySync> }) {
  const { userId, secrets, source, intents, authoritySync } = port; assertSharedIdentifier(userId);
  async function resume() {
    const pending = (await source.read())?.pending; if (!pending) return { kind: 'idle' as const };
    const current = await secrets.authority(userId); if (!current) throw new Error('本人端末の信頼を確認してください。');
    if (current.digest === pending.signed.body.previousDigest) {
      const body = pending.signed.body;
      const prepared = await intents.prepare({ devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: body.keyVersion }, await secrets.identity(userId), { purpose: 'calendarSourceChange' });
      if (!prepared || prepared.digest !== pending.digest) throw new Error('取得元の変更と準備済みの端末設定が一致しません。');
      const accepted = await authoritySync.resume();
      if (accepted.kind === 'review') return { kind: 'review' as const, targetDigest: pending.digest, observedCurrentDigest: accepted.observedCurrentDigest };
      if (accepted.kind === 'accepted' && accepted.intentDigest === pending.digest) {
        if (!await source.commitAccepted(pending.digest, accepted.authority.digest)) throw new Error('取得元の受付確認中に本人設定が変わりました。');
        return { kind: 'ready' as const, authorityDigest: accepted.authority.digest };
      }
    }
    // Includes a crash after SQL receipt but before the protected source commit, or a later device change.
    const verified = await authoritySync.refresh(); const accepted = verified.history[pending.signed.body.revision - 1];
    if (!accepted || sharedDocumentDigest(accepted) !== pending.digest) return { kind: 'review' as const, targetDigest: pending.digest, observedCurrentDigest: verified.authority.digest };
    const leftover = await intents.readPending();
    if (leftover?.digest === pending.digest && !await intents.markAccepted(pending.digest, verified.authority)) throw new Error('取得元に対応する端末設定の受付を確認できません。');
    if (!await source.commitAccepted(pending.digest, verified.authority.digest)) throw new Error('取得元の受付確認中に本人設定が変わりました。');
    return { kind: 'ready' as const, authorityDigest: verified.authority.digest };
  }
  let flight: Promise<unknown> | null = null;
  function exclusive<T>(work: () => Promise<T>) {
    if (flight) return Promise.reject(new Error('取得元の操作が終わってから再試行してください。'));
    const pending = work(); flight = pending; void pending.finally(() => { if (flight === pending) flight = null; }).catch(() => {}); return pending;
  }
  return {
    read: source.read,
    /** Only during explicit refresh, never passive per-card reads. A prior main must not revive an obsolete source. */
    async isCurrentSelection() {
      const profile = await source.read(); const current = await secrets.publicState(userId);
      if (!profile?.active || profile.pending || !current?.authority || current.authority.signed.body.mainDeviceId !== current.identity.deviceId) return false;
      if (profile.active.authorityDigest === current.authority.digest) return true;
      const verified = await authoritySync.refresh(); const after = await source.read(); const state = await secrets.publicState(userId);
      return !after?.pending && after?.active?.authorityDigest === latestSourceDigest(verified.history)
        && state?.authority?.digest === verified.authority.digest && verified.authority.signed.body.mainDeviceId === state.identity.deviceId;
    },
    resume: () => exclusive(resume),
    change(selected: PrivateCalendarSourceChoice, expectedAuthorityDigest: string) {
      // Never infer a Google subject from Firebase UID or any personal/group database.
      exactRecord(selected, ['googleSubject']);
      if (selected.googleSubject !== null) assertSharedIdentifier(selected.googleSubject); const owned = { googleSubject: selected.googleSubject };
      hexBytes(expectedAuthorityDigest, 32);
      return exclusive(async () => {
        if ((await source.read())?.pending) throw new Error('取得元の変更が確認待ちです。元の変更を再開してください。');
        const { authority, history } = await authoritySync.refresh();
        if (authority.digest !== expectedAuthorityDigest) throw new Error('表示後に本人端末の設定が変わりました。再確認してください。');
        const state = await secrets.publicState(userId);
        if (!state || authority.signed.body.mainDeviceId !== state.identity.deviceId) throw new Error('取得元は現在のメイン端末で設定してください。');
        const previous = await source.read();
        if (previous?.active?.googleSubject === owned.googleSubject && previous.active.authorityDigest === latestSourceDigest(history)) return { kind: 'ready' as const, authorityDigest: authority.digest };
        const body = authority.signed.body;
        const signed = advancePrivateCalendarAuthority(authority, { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: body.keyVersion }, await secrets.identity(userId), { purpose: 'calendarSourceChange' });
        assertPrivateCalendarAuthorityAppend(history, signed.signed);
        await source.prepare(signed.signed, owned); return resume();
      });
    },
    dismissReviewed(targetDigest: string, expectedHeadDigest: string) {
      hexBytes(targetDigest, 32); hexBytes(expectedHeadDigest, 32);
      return exclusive(async () => {
        const pending = (await source.read())?.pending;
        if (!pending || pending.digest !== targetDigest) throw new Error('確認待ちの取得元が変わりました。');
        const verified = await authoritySync.refresh();
        if (verified.authority.digest !== expectedHeadDigest) throw new Error('確認した本人端末の設定が変わりました。');
        const accepted = verified.history[pending.signed.body.revision - 1];
        if (accepted && sharedDocumentDigest(accepted) === pending.digest) throw new Error('受付済みの取得元は元に戻さず、確定後に新しい変更を行ってください。');
        const leftover = await intents.readPending();
        if (leftover?.digest === pending.digest && !await authoritySync.dismissReviewed(pending.digest, expectedHeadDigest)) throw new Error('元の端末変更を取り下げられませんでした。');
        if (!await source.dismissReviewed(pending.digest, expectedHeadDigest)) throw new Error('元の取得元変更を取り下げられませんでした。');
        return { kind: 'dismissed' as const };
      });
    },
  };
}
