import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonthDragDriver, monthDragEdgeSpeed } from '../src/features/calendar/month-drag-driver.ts';
import { calendarMonthDragTarget } from '../src/features/calendar/direct-actions.ts';
import { calendarMonthRows } from '../src/features/calendar/month-rows.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';

const viewport = { x: 0, y: 100, width: 700, height: 400 };
function clock() {
  let id = 0; let at = 0; const pending = new Map();
  return { request: callback => { pending.set(++id, callback); return id; }, cancel: id => pending.delete(id),
    step: (count = 1) => { for (let i = 0; i < count; i++) { at += 16; const work = [...pending.values()]; pending.clear(); work.forEach(callback => callback(at)); } },
    queued: () => pending.size };
}
function fixture() {
  const frames = clock(); const rows = calendarMonthRows(Array.from({ length: 70 }, (_, i) => addDays('2026-11-01', i * 7)), 100);
  let offset = 238; const writes = []; const previews = []; let ended = 0;
  const driver = createMonthDragDriver(frames);
  const event = { ...newEventDraft('2026-11-15', 'Asia/Tokyo'), id: 'drag-event', eventId: 'event', startMinute: 865 };
  const config = { enabled: true, viewport: () => viewport, offset: () => offset, limit: () => rows.at(-1).offset,
    scroll: next => { offset = next; }, resolve: (start, point) => calendarMonthDragTarget(start.event, start.day, rows, viewport, offset, point.x, point.y),
    begin: () => {}, end: () => { ended++; }, preview: (_start, _point, target) => previews.push(target), commit: async (capture, target) => writes.push({ capture, target }) };
  const start = { event, day: event.startDate, capture: { basisRevision: 'captured-proof' }, point: { x: 50, y: 170 }, frame: { x: 0, y: 150, width: 100, height: 40 }, preview: 'held card' };
  driver.update(config);
  return { driver, frames, writes, previews, config, start, offset: () => offset, ended: () => ended };
}
test('month edge scrolling accelerates toward either edge and stops outside the grid or in its center', () => {
  assert.equal(monthDragEdgeSpeed(viewport, { x: 300, y: 300 }), 0);
  assert.ok(monthDragEdgeSpeed(viewport, { x: 300, y: 101 }) < monthDragEdgeSpeed(viewport, { x: 300, y: 150 }));
  assert.ok(monthDragEdgeSpeed(viewport, { x: 300, y: 499 }) > monthDragEdgeSpeed(viewport, { x: 300, y: 450 }));
  for (const point of [{ x: -1, y: 490 }, { x: 700, y: 490 }, { x: 5, y: 500 }, { x: 5, y: 99 }, { x: NaN, y: 150 }]) assert.equal(monthDragEdgeSpeed(viewport, point), 0);
});
test('a stationary held pointer scrolls through unseen weeks and months and saves only its final date without changing time', () => {
  const f = fixture(); f.driver.start(f.start); f.driver.claim();
  const point = { x: 350, y: 495 }; f.driver.move(point, 1);
  const first = f.previews.at(-1).day; f.frames.step(180);
  assert.ok(f.offset() > 1200); assert.ok(f.previews.at(-1).day > first); assert.deepEqual(f.writes, []);
  const last = f.previews.at(-1); f.driver.finish(point); f.driver.finish(point);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].target, last); assert.equal(last.minute, 865);
  assert.equal(f.writes[0].capture.basisRevision, 'captured-proof'); assert.equal(f.frames.queued(), 0); assert.equal(f.ended(), 1);
});
test('month edge scrolling reverses stops in the middle and cancels on gesture or view interruption', () => {
  const f = fixture(); f.driver.start(f.start); f.driver.claim(); f.driver.move({ x: 50, y: 495 }, 1); f.frames.step(80);
  const down = f.offset(); f.driver.move({ x: 50, y: 105 }, 1); f.frames.step(30); assert.ok(f.offset() < down);
  f.driver.move({ x: 50, y: 300 }, 1); const stopped = f.offset(); f.frames.step(80); assert.equal(f.offset(), stopped); assert.equal(f.frames.queued(), 0);
  f.driver.move({ x: 50, y: 495 }, 1); f.driver.move({ x: 50, y: 495 }, 2); assert.equal(f.driver.active(), false); assert.equal(f.frames.queued(), 0); assert.deepEqual(f.writes, []);
  f.driver.start(f.start); f.driver.claim(); f.driver.move({ x: 50, y: 495 }, 1); f.driver.update({ ...f.config, enabled: false });
  f.frames.step(20); assert.equal(f.driver.active(), false); assert.equal(f.frames.queued(), 0); assert.deepEqual(f.writes, []);
});
test('month auto scrolling cannot run before gesture ownership and clamps at the real list boundaries', () => {
  const f = fixture(); f.driver.start(f.start); f.driver.move({ x: 50, y: 495 }, 1); f.frames.step(100); assert.equal(f.offset(), 238);
  f.driver.unclaimedEnd(); assert.equal(f.driver.active(), false);
  f.driver.start(f.start); f.driver.claim(); f.driver.move({ x: 50, y: 101 }, 1); f.frames.step(1000);
  assert.equal(f.offset(), 0); assert.equal(f.frames.queued(), 0); f.driver.unclaimedEnd(); assert.equal(f.driver.active(), true);
  f.driver.move({ x: 50, y: 499 }, 1); f.frames.step(3000); assert.equal(f.offset(), f.config.limit()); assert.equal(f.frames.queued(), 0);
  f.driver.cancel(); assert.deepEqual(f.writes, []);
});

test('a native touch end stops edge scrolling even if a virtualized source never delivers responder release', () => {
  const f = fixture(); const point = { x: 350, y: 495 };
  f.driver.start(f.start); f.driver.claim(); f.driver.move(point, 1); f.frames.step(180);
  f.driver.touchEnd(point); const stopped = f.offset(); f.frames.step(100);
  f.driver.finish(point); assert.equal(f.writes.length, 1); assert.equal(f.offset(), stopped); assert.equal(f.frames.queued(), 0);
  f.driver.start(f.start); f.driver.touchEnd(point); assert.equal(f.driver.active(), false); assert.equal(f.writes.length, 1);
});

test('a failed drop resolution releases the month drag and its scheduled frames', () => {
  const f = fixture();
  const point = { x: 350, y: 495 };
  f.driver.start(f.start);
  f.driver.claim();
  f.driver.move(point, 1);
  assert.ok(f.frames.queued() > 0);
  f.driver.update({ ...f.config, resolve: () => { throw new Error('unavailable drop target'); } });
  assert.throws(() => f.driver.finish(point), /unavailable drop target/u);
  assert.equal(f.driver.active(), false);
  assert.equal(f.ended(), 1);
  assert.equal(f.frames.queued(), 0);
  assert.deepEqual(f.writes, []);
});
