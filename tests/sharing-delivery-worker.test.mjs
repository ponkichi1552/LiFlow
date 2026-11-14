import assert from 'node:assert/strict';
import test from 'node:test';
import { startSharedDeliveryWorker } from '../server/appliance-care-api/src/sharing-delivery-worker.mjs';

test('delivery cleanup listeners retry actual failures without idle polling and shutdown cancels reconnection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = []; const target = { where() { return this; }, onSnapshot(changed, failed) {
    const observer = { changed, failed, closed: false }; listeners.push(observer); return () => { observer.closed = true; };
  } };
  const stop = startSharedDeliveryWorker({ collectionGroup: () => target });
  try {
    listeners[0].changed({ docChanges: () => [] }); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 1);
    listeners[0].failed(); assert.equal(listeners[0].closed, true);
    t.mock.timers.tick(29_999); assert.equal(listeners.length, 1);
    t.mock.timers.tick(1); assert.equal(listeners.length, 2);
    listeners[1].changed({ docChanges: () => [] }); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 2);
    listeners[1].failed(); stop(); t.mock.timers.tick(86400_000); assert.equal(listeners.length, 2);
  } finally { stop(); }
});
