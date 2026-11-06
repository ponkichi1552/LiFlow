import { canonicalJson } from '../../features/sharing/operations.ts';
import { parseAccountDeviceRestoreReceipts } from '../../features/sharing/account-device-restore.ts';
import type { AccountDeviceRestoreApi } from '../../features/sharing/account-device-controller.ts';

export class AccountDeviceRequestError extends Error {
  readonly code: string;
  constructor(code: string) { super('共有グループを復元できませんでした。接続後に再試行します。'); this.code = code; }
}
/** Never redirects an identity token or includes a provider response in an error. */
export function createAccountDeviceApi(input: { url: string; userId: string; assertCurrent(): void;
  getToken(): Promise<string>; fetch?: typeof fetch; budgetMs?: number; testLoopback?: boolean }): AccountDeviceRestoreApi {
  const base = new URL(input.url);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || !(base.protocol === 'https:' || input.testLoopback === true && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Invalid account restoration endpoint');
  const transport = input.fetch ?? fetch, budgetMs = Math.max(1000, Math.min(input.budgetMs ?? 15_000, 20_000));
  async function post(method: string, body: unknown) {
    input.assertCurrent(); const controller = new AbortController(); let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => { input.assertCurrent(); if (timedOut) throw new AccountDeviceRequestError('request_timeout'); };
    try {
      const task = (async () => {
        const token = await input.getToken(); check();
        if (!token || token.length > 12000 || !/^[A-Za-z0-9._-]+$/u.test(token)) throw new AccountDeviceRequestError('identity_required');
        const encoded = canonicalJson(body);
        if (new TextEncoder().encode(encoded).length > 256000) throw new AccountDeviceRequestError('request_too_large');
        const response = await transport(new URL(`/v1/restore/${method}`, base).href, { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: encoded, signal: controller.signal });
        check();
        if (response.redirected || response.url && new URL(response.url).origin !== base.origin) throw new AccountDeviceRequestError('endpoint_changed');
        const raw = await response.text(); check();
        // A read may contain four separately bounded encrypted grants.
        if (raw.length > 1_048_576 || !/^application\/json\b/iu.test(response.headers.get('content-type') ?? '')) throw new AccountDeviceRequestError('invalid_response');
        let result: unknown;
        try { result = JSON.parse(raw); } catch { throw new AccountDeviceRequestError('invalid_response'); }
        if (!response.ok) {
          const code = (result as { code?: unknown })?.code;
          throw new AccountDeviceRequestError(typeof code === 'string' && /^[a-z_]{1,80}$/u.test(code) ? code : 'retry_later');
        }
        return result;
      })();
      return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => {
        timedOut = true; controller.abort(); reject(new AccountDeviceRequestError('request_timeout'));
      }, budgetMs); })]);
    } catch (error) {
      if (error instanceof AccountDeviceRequestError) throw error;
      throw new AccountDeviceRequestError('retry_later');
    } finally { clearTimeout(timer); }
  }
  const status = async (method: string, body: unknown, expected: string) => {
    const result = await post(method, body);
    if (!result || typeof result !== 'object' || Object.keys(result).join(',') !== 'status'
      || (result as { status: unknown }).status !== expected) throw new AccountDeviceRequestError('invalid_response');
  };
  return {
    read: async groupId => parseAccountDeviceRestoreReceipts(await post('read', { groupId }), input.userId, groupId),
    request: body => status('request', body, 'requested'), accept: body => status('accept', body, 'accepted'),
    acknowledge: body => status('acknowledge', body, 'acknowledged'),
  };
}
