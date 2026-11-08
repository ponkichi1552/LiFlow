import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarAuthorityIntentStorage } from '../../../platform/storage/private-calendar-authority-intents.ts';
import type { SignedPrivateCalendarAuthority, VerifiedPrivateCalendarAuthority, PrivateCalendarAuthorityChange } from './authority.ts';
import { snapshotPrivateCalendarAuthority, snapshotPrivateCalendarAuthorityChange, verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from './authority.ts';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { assertPrivateCalendarCloudAuthority, PrivateCalendarCloudConflict } from './cloud-contract.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { assertPrivateCalendarAuthorityAppend, MAX_PRIVATE_CALENDAR_AUTHORITIES, MAX_PRIVATE_CALENDAR_AUTHORITY_HISTORY_BYTES, MAX_PRIVATE_CALENDAR_AUTHORITY_DOCUMENT_BYTES } from './authority-history-limits.ts';
import { assertPrivateCalendarWork, privateCalendarWork } from './sync-deadline.ts';
import type { PrivateCalendarWorkControl } from './sync-deadline.ts';

type Cloud = Pick<ReturnType<typeof createPrivateCalendarCloud>, 'authorityPage' | 'commitAuthority'>;
type VerifiedHistory = { authority: VerifiedPrivateCalendarAuthority; history: readonly SignedPrivateCalendarAuthority[]; bytes: number };
/** Used for approval/recovery, not per-card rendering. A cloud checkpoint cannot substitute for the pinned signature chain. */
export async function collectPrivateCalendarAuthorityHistory(cloud: Pick<Cloud, 'authorityPage'>, expected: VerifiedPrivateCalendarAuthority,
  initialPage?: Awaited<ReturnType<Cloud['authorityPage']>>, control: PrivateCalendarWorkControl = {}) {
  return collectHistory(cloud, expected, initialPage, control);
}
async function collectHistory(cloud: Pick<Cloud, 'authorityPage'>, expected: VerifiedPrivateCalendarAuthority,
  initialPage: Awaited<ReturnType<Cloud['authorityPage']>> | undefined, control: PrivateCalendarWorkControl, seed?: VerifiedHistory) {
  const history = seed ? [...seed.history] : []; let current: VerifiedPrivateCalendarAuthority | null = seed?.authority ?? null;
  let bytes = seed?.bytes ?? 0; let observedRevision = Math.max(expected.signed.body.revision, current?.signed.body.revision ?? 0);
  let expectedFound = Boolean(seed && history[expected.signed.body.revision - 1]
    && sharedDocumentDigest(history[expected.signed.body.revision - 1]) === expected.digest);
  while (history.length <= MAX_PRIVATE_CALENDAR_AUTHORITIES) {
    assertPrivateCalendarWork(control);
    const page = history.length === 0 && initialPage ? initialPage : await privateCalendarWork(() => cloud.authorityPage(history.length, control.assertBudget), control);
    if (!page || page.head.rootDigest !== expected.anchor.rootDigest || page.head.accountGeneration !== expected.anchor.accountGeneration
      || page.head.ownerUserId !== expected.anchor.ownerUserId || page.head.authorityRevision < observedRevision
      || page.authorities.length > 100 || !page.authorities.length && (!current || current.signed.body.revision !== page.head.authorityRevision)) throw new Error('本人端末の署名履歴と確認済みの設定が一致しません。');
    observedRevision = page.head.authorityRevision;
    for (const raw of page.authorities) {
      assertPrivateCalendarWork(control);
      const signed = snapshotPrivateCalendarAuthority(raw); bytes += canonicalJson(signed).length;
      if (history.length >= MAX_PRIVATE_CALENDAR_AUTHORITIES || bytes > MAX_PRIVATE_CALENDAR_AUTHORITY_HISTORY_BYTES) throw new Error('本人端末の署名履歴が上限を超えています。');
      current = current ? verifyPrivateCalendarAuthorityUpdate(current, signed) : verifyPrivateCalendarRoot(signed, expected.anchor);
      history.push(current.signed);
      if (current.signed.body.revision === expected.signed.body.revision) {
        if (current.digest !== expected.digest) throw new Error('本人端末で保護した設定と署名履歴が分岐しています。'); expectedFound = true;
      }
    }
    if (current!.signed.body.revision === page.head.authorityRevision) {
      assertPrivateCalendarCloudAuthority(page.head, current!);
      if (!expectedFound) throw new Error('確認済みの本人端末の設定まで署名履歴がありません。');
      return { authority: current!, history, bytes };
    }
    if (current!.signed.body.revision > page.head.authorityRevision) throw new Error('本人端末の署名履歴の取得位置が異なります。');
  }
  throw new Error('本人端末の署名履歴が上限を超えています。');
}

export function createPrivateCalendarAuthoritySync(port: { userId: string; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  intents: ReturnType<typeof createPrivateCalendarAuthorityIntentStorage>; cloud: Cloud }) {
  const { userId, secrets, intents, cloud } = port; assertSharedIdentifier(userId);
  let verified: VerifiedHistory | undefined;
  // The runtime creates a new AbortSignal for each bounded synchronization. Reuse only within that exact work scope.
  const workHistory = new WeakMap<AbortSignal, VerifiedHistory>();
  const contains = (value: VerifiedHistory | undefined, expected: VerifiedPrivateCalendarAuthority): value is VerifiedHistory => Boolean(value
    && value.authority.anchor.ownerUserId === userId && value.authority.anchor.rootDigest === expected.anchor.rootDigest
    && value.authority.anchor.accountGeneration === expected.anchor.accountGeneration
    && value.history[expected.signed.body.revision - 1]
    && sharedDocumentDigest(value.history[expected.signed.body.revision - 1]) === expected.digest);
  async function refresh(control: PrivateCalendarWorkControl = {}) {
    assertPrivateCalendarWork(control);
    const before = await secrets.authority(userId); if (!before) throw new Error('本人端末の信頼を先に確認してください。');
    const sameWork = control.signal ? workHistory.get(control.signal) : undefined;
    const collected = contains(sameWork, before) && sameWork.authority.digest === before.digest
      ? { ...sameWork, history: [...sameWork.history] }
      : await collectHistory(cloud, before, undefined, control, contains(verified, before) ? verified : undefined);
    // Another runtime may have applied a prefix while the server pages were being read.
    let current = await secrets.authority(userId); if (!current) throw new Error('本人端末の信頼が変わりました。');
    for (;;) {
      assertPrivateCalendarWork(control);
      const revision = current.signed.body.revision;
      if (!collected.history[revision - 1] || sharedDocumentDigest(collected.history[revision - 1]) !== current.digest) throw new Error('本人端末の設定が取得中に変わりました。再同期してください。');
      if (revision === collected.history.length) break;
      try { current = await secrets.acceptAuthorityUpdate(userId, collected.history[revision]); assertPrivateCalendarWork(control); }
      catch (error) {
        assertPrivateCalendarWork(control);
        const advanced = await secrets.authority(userId);
        if (!advanced || advanced.signed.body.revision <= revision) throw error;
        current = advanced;
      }
    }
    assertPrivateCalendarWork(control);
    if (!current.keyIssuer) current = await secrets.recoverKeyIssuerHistory(userId, collected.history);
    assertPrivateCalendarWork(control);
    verified = { authority: current, history: Object.freeze([...collected.history]), bytes: collected.bytes };
    if (control.signal) workHistory.set(control.signal, verified);
    return { authority: current, history: [...verified.history] };
  }
  async function resume(control: PrivateCalendarWorkControl = {}) {
    assertPrivateCalendarWork(control);
    const saved = await intents.readPending(); if (!saved) return { kind: 'idle' as const };
    // A pending commit can advance the server without advancing the protected local pin yet.
    if (control.signal) workHistory.delete(control.signal);
    if (saved.current.digest === saved.signed.body.previousDigest) {
      const next = verifyPrivateCalendarAuthorityUpdate(saved.current, saved.signed);
      let mayCommit = true;
      if (next.signed.body.revision > MAX_PRIVATE_CALENDAR_AUTHORITIES) throw new Error('本人端末の署名履歴が上限に達しています。準備した設定は保持しています。');
      // Small chains are bounded by the existing per-document transport limit. Near capacity,
      // verify the complete chain before committing, rather than discovering overflow afterward.
      if (next.signed.body.revision * MAX_PRIVATE_CALENDAR_AUTHORITY_DOCUMENT_BYTES > MAX_PRIVATE_CALENDAR_AUTHORITY_HISTORY_BYTES) {
        const before = await collectPrivateCalendarAuthorityHistory(cloud, saved.current, undefined, control);
        mayCommit = before.authority.digest === saved.current.digest;
        if (mayCommit) assertPrivateCalendarAuthorityAppend(before.history, next.signed);
      }
      try { if (mayCommit) await privateCalendarWork(() => cloud.commitAuthority(saved.current, next, control.assertBudget), control); }
      catch (error) { if (!(error instanceof PrivateCalendarCloudConflict)) throw error; }
    }
    const collected = await refresh(control);
    const accepted = collected.history[saved.signed.body.revision - 1];
    if (!accepted) throw new Error('本人端末の変更の受付がまだ確認できません。準備内容を保持して再同期してください。');
    if (sharedDocumentDigest(accepted) !== saved.digest) {
      return { kind: 'review' as const, intentDigest: saved.digest, observedCurrentDigest: collected.authority.digest };
    }
    assertPrivateCalendarWork(control);
    if (!await intents.markAccepted(saved.digest, collected.authority)) throw new Error('本人端末の受付確認中に設定が変わりました。再同期してください。');
    return { kind: 'accepted' as const, authority: collected.authority, intentDigest: saved.digest };
  }
  return { refresh, resume, async change(change: PrivateCalendarAuthorityChange, control: PrivateCalendarWorkControl = {}) {
    assertPrivateCalendarWork(control);
    const owned = snapshotPrivateCalendarAuthorityChange(change);
    if (!await secrets.authority(userId)) throw new Error('本人端末の信頼を先に確認してください。');
    const identity = await secrets.identity(userId); assertPrivateCalendarWork(control);
    const saved = await intents.prepare(owned, identity); assertPrivateCalendarWork(control);
    return saved ? resume(control) : { kind: 'idle' as const };
  }, dismissReviewed: intents.dismissReviewed };
}
