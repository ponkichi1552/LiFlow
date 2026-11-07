/** Raised only before the native schedule request, never for an uncertain OS reply. */
export class NoticeNotIssuedError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : '通知を送信できませんでした。', { cause }); this.name='NoticeNotIssuedError'; }
}
