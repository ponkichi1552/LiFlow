/** A transport bound, including whitespace and unused JSON fields. Native fetch
 * may expose only text(); streaming implementations stop the transfer early. */
export const GOOGLE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export class GoogleResponseTooLargeError extends Error {
  constructor() { super('Google response exceeded its transport limit'); this.name = 'GoogleResponseTooLargeError'; }
}
export async function readGoogleResponseText(response: Response, signal?: AbortSignal, maximum = GOOGLE_RESPONSE_MAX_BYTES): Promise<string> {
  const advertised = response.headers?.get?.('Content-Length');
  if (advertised && /^\d+$/u.test(advertised) && Number(advertised) > maximum) {
    void response.body?.cancel?.().catch(() => undefined); throw new GoogleResponseTooLargeError();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const value = await response.text(); signal?.throwIfAborted();
    if (new TextEncoder().encode(value).byteLength > maximum) throw new GoogleResponseTooLargeError();
    return value;
  }
  const decoder = new TextDecoder(); const parts: string[] = []; let size = 0; let complete = false;
  try {
    for (;;) {
      signal?.throwIfAborted(); const chunk = await reader.read(); signal?.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > maximum) throw new GoogleResponseTooLargeError();
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode()); return parts.join('');
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
