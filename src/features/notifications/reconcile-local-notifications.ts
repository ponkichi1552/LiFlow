import { ExpiredNotificationRequestError } from './expired-request.ts';
import type { LocalNotificationGateway, LocalNotificationRequest } from './contracts';

const queues = new WeakMap<LocalNotificationGateway, Promise<void>>();
export interface NotificationReconciliationResult {
  scheduled: number; unchanged: number; cancelled: number;
  deadlineExcluded: number; capacityExcluded: number; permissionExcluded: number; failed: number;
}
export class NotificationReconciliationError extends Error {
  readonly result: NotificationReconciliationResult;
  constructor(result: NotificationReconciliationResult, cause: unknown) {
    super('一部の通知を更新できませんでした。次の更新時に再試行します。', { cause }); this.name = 'NotificationReconciliationError'; this.result = result;
  }
}

/** Immediate delivery and cancellation share the same queue as future planner reminders. */
export function withLocalNotificationOperation<T>(gateway: LocalNotificationGateway, execute: () => Promise<T>): Promise<T> {
  const operation = (queues.get(gateway) ?? Promise.resolve()).then(execute, execute);
  const tail = operation.then(() => undefined, () => undefined); queues.set(gateway, tail);
  void tail.then(() => { if (queues.get(gateway) === tail) queues.delete(gateway); });
  return operation;
}

/** All planner domains share the native queue. A scope can replace/cancel only its own keys. */
export function reconcileLocalNotifications(gateway: LocalNotificationGateway, input: {
  prefix: string; desired: readonly LocalNotificationRequest[]; enabled: boolean;
  assertCurrent?: () => void | Promise<void>;
}): Promise<NotificationReconciliationResult> {
  if (typeof input.prefix !== 'string' || !input.prefix || input.desired.some(request => typeof request.key !== 'string' || !request.key.startsWith(input.prefix))
    || new Set(input.desired.map(request => request.key)).size !== input.desired.length
    || input.desired.some(request => !Number.isFinite(Date.parse(request.fireAt)))) return Promise.reject(new Error('通知の保存先・日時を確認してください。'));
  const prefix = input.prefix; const enabled = input.enabled; const assertCurrent = input.assertCurrent;
  const desired = input.desired.map(request => ({ ...request, ...(request.data ? { data: { ...request.data } } : {}) }));
  const execute = async () => {
    await assertCurrent?.();
    const existing = await gateway.getScheduledRequests();
    const permitted = enabled && await gateway.hasPermission();
    const deadline = await gateway.schedulingDeadline?.() ?? Infinity;
    await assertCurrent?.();
    const otherCount = existing.filter(request => !request.key.startsWith(prefix)).length;
    const capacity = gateway.maximumScheduledRequests;
    if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 0)) throw new Error('通知の上限を確認してください。');
    const room = capacity === undefined ? Infinity : Math.max(0, capacity - otherCount);
    const eligible = permitted ? desired.filter(request => Date.parse(request.fireAt) < deadline)
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt) || a.key.localeCompare(b.key)) : [];
    const requests = eligible.slice(0, room);
    const result: NotificationReconciliationResult = { scheduled: 0, unchanged: 0, cancelled: 0,
      deadlineExcluded: permitted ? desired.length - eligible.length : 0, capacityExcluded: eligible.length - requests.length,
      permissionExcluded: enabled && !permitted ? desired.length : 0, failed: 0 };
    const desiredKeys = new Set(requests.map(request => request.key));
    const byKey = new Map(existing.map(request => [request.key, request]));
    const obsolete = existing.filter(request => request.key.startsWith(prefix) && !desiredKeys.has(request.key));
    const failures: unknown[] = [];
    let cancelled = 0;
    // Capacity-limited platforms need free slots before new requests; uncapped legacy ordering stays unchanged.
    const cancel = async () => {
      for (const request of obsolete) {
        await assertCurrent?.();
        try { await gateway.cancel(request.key); cancelled++; }
        catch (error) { failures.push(error); }
      }
    };
    if (capacity !== undefined) await cancel();
    let count = existing.length - cancelled;
    for (const request of requests) {
      await assertCurrent?.();
      const previous = byKey.get(request.key);
      if (previous && signature(previous) === signature(request)) { result.unchanged++; continue; }
      if (!previous && capacity !== undefined && count >= capacity) { result.capacityExcluded++; continue; }
      try { await gateway.schedule(request); result.scheduled++; if (!previous) count++; }
      catch (error) {
        if (error instanceof ExpiredNotificationRequestError) {
          result.deadlineExcluded++;
          // This error is raised before issuing a native request. The old time
          // is no longer wanted, even though its replacement can no longer fire.
          if (previous) {
            await assertCurrent?.();
            try { await gateway.cancel(request.key); cancelled++; count--; }
            catch (cancelError) { failures.push(cancelError); }
          }
        } else failures.push(error);
      }
    }
    if (capacity === undefined) await cancel();
    await assertCurrent?.();
    result.cancelled = cancelled; result.failed = failures.length;
    if (failures.length) throw new NotificationReconciliationError(result, failures[0]);
    return result;
  };
  return withLocalNotificationOperation(gateway, execute);
}
function signature(request: LocalNotificationRequest) {
  return JSON.stringify([request.title, request.subtitle ?? '', request.body, request.fireAt,
    Object.entries(request.data ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}
