import type { LocalNotificationGateway, LocalNotificationRequest } from './contracts';

const queues = new WeakMap<LocalNotificationGateway, Promise<void>>();

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
}): Promise<void> {
  if (typeof input.prefix !== 'string' || !input.prefix || input.desired.some(request => typeof request.key !== 'string' || !request.key.startsWith(input.prefix))
    || new Set(input.desired.map(request => request.key)).size !== input.desired.length) return Promise.reject(new Error('通知の保存先を確認してください。'));
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
    const requests = permitted ? desired.filter(request => Date.parse(request.fireAt) < deadline)
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt) || a.key.localeCompare(b.key)).slice(0, room) : [];
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
      if (previous && signature(previous) === signature(request)) continue;
      if (!previous && capacity !== undefined && count >= capacity) continue;
      try { await gateway.schedule(request); if (!previous) count++; }
      catch (error) { failures.push(error); }
    }
    if (capacity === undefined) await cancel();
    await assertCurrent?.();
    if (failures.length) throw failures[0];
  };
  return withLocalNotificationOperation(gateway, execute);
}
function signature(request: LocalNotificationRequest) {
  return JSON.stringify([request.title, request.subtitle ?? '', request.body, request.fireAt,
    Object.entries(request.data ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}
