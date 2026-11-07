import type { V2CompletionNoticeStore } from '../../../platform/storage/sharing-v2-completion-notices';
import { v2CompletionNoticePrefix } from './completion-notices.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { NoticeNotIssuedError } from '../../notifications/notice-delivery.ts';

export interface V2CompletionNotice { key: string; title: string; body: string; count: number }
export function createV2CompletionNoticeRuntime(input: { userId: string; groupId: string; store: V2CompletionNoticeStore;
  hasPermission(): Promise<boolean>; present(notice: V2CompletionNotice, assertCurrent: () => Promise<void>, beforePresent: () => Promise<boolean>): Promise<void | boolean>; assertAccess(): void | Promise<void>; now?: () => Date; budgetNow?: () => number }) {
  if (input.store.scope.userId !== input.userId || input.store.scope.groupId !== input.groupId) throw new Error('完了通知する本人とグループを確認してください。');
  let running: Promise<void> | null = null; let requested = false; let deadline = 0; const clock = input.budgetNow ?? Date.now;
  const guard = async () => { if (clock() >= deadline) throw new Error('完了通知は次の同期で確認します。'); await input.assertAccess(); if (clock() >= deadline) throw new Error('完了通知は次の同期で確認します。'); };
  async function execute() {
    for (let pass = 0; pass < 3; pass++) {
      requested = false; await guard(); if (!await input.store.enabled()) return; await guard();
      const permitted = await input.hasPermission(); await guard();
      const batch = await input.store.collect(permitted, (input.now ?? (() => new Date()))(), guard); await guard();
      if (batch && await input.store.current(batch)) {
        await guard(); if (!await input.hasPermission()) return; await guard();
        if (!await input.store.current(batch)) continue; await guard();
        const values = batch.names.slice(0, 4).map(name => name.length > 80 ? `${name.slice(0, 80)}…` : name);
        let issued = false;
        try { const sent = await input.present({ key: v2CompletionNoticePrefix(input.userId, input.groupId) + sharedDocumentDigest(batch.keys.join('')), title: '共有家事が完了しました',
          body: `${values.join('、')}${batch.names.length > 4 ? `、ほか${batch.names.length - 4}件` : ''}`, count: batch.names.length }, async () => {
          await guard(); if (!await input.store.current(batch)) throw new Error('通知前に完了状態が変わりました。'); await guard();
        }, async () => { await guard(); issued = await input.store.issue(batch, guard); return issued; });
        if (sent === false && issued) await input.store.notIssued(batch);
        } catch (error) { if (error instanceof NoticeNotIssuedError && issued) await input.store.notIssued(batch); throw error; }
        finally { if (issued) await input.store.settled?.(batch).catch(() => {}); }
        await guard();
      }
      if (batch && !await input.store.current(batch)) continue;
      if (!requested) return;
    }
  }
  return { synchronize(budgetMs = 10_000) {
    if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 60_000) return Promise.reject(new Error('完了通知の時間枠を確認してください。'));
    if (running) { requested = true; deadline = Math.min(deadline, clock() + budgetMs); return running; }
    deadline = clock() + budgetMs; const pending = execute(); running = pending;
    void pending.finally(() => { if (running === pending) running = null; }).catch(() => {}); return pending;
  } };
}
