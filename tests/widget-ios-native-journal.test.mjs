import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Exercise the actual app/extension journal, including separate OS processes and file locks.
// iOS-native compilation is also part of the release build; CI on Linux does not emulate Darwin.
test('iOS native durable widget journal preserves new taps during exact acknowledgement and refuses stale or expired input', { skip: process.platform !== 'darwin' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'liflow-widget-journal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = readFileSync(new URL('../plugins/ios/WidgetCompletionJournal.swift', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'main.swift'), `import Foundation
enum WidgetsStorage { static var appGroupIdentifier: String? = nil }
${helper}
let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let mode = CommandLine.arguments[2]
if mode == "append" {
  try LiflowWidgetInputJournal.append(["id": CommandLine.arguments[3]], at: dir)
} else if mode == "append-payload" {
  try LiflowWidgetInputJournal.append(["id": CommandLine.arguments[3], "note": CommandLine.arguments[4]], at: dir)
} else if mode == "ack" {
  try LiflowWidgetInputJournal.acknowledge(Array(CommandLine.arguments.dropFirst(3)), at: dir)
} else if mode == "read" {
  let data = try JSONSerialization.data(withJSONObject: LiflowWidgetInputJournal.read(at: dir)); print(String(decoding: data, as: UTF8.self))
} else if mode == "accept" {
  let data = Data(CommandLine.arguments[3].utf8)
  let props = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  print(try LiflowWidgetInputJournal.accept(props: props, target: "complete:row", at: dir))
}`);
  const binary = join(dir, 'journal'); const compilation = spawnSync('xcrun', ['swiftc', join(dir, 'main.swift'), '-o', binary], { encoding: 'utf8' });
  assert.equal(compilation.status, 0, compilation.stderr);
  const journal = join(dir, 'data');
  const call = (mode, ...args) => new Promise((resolve, reject) => {
    const child = spawn(binary, [journal, mode, ...args]); let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  });
  const id = n => `completion-intent.00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await Promise.all(Array.from({ length: 32 }, (_, i) => call('append', id(i))));
  assert.equal(JSON.parse(await call('read')).length, 32);
  const observed = JSON.parse(await call('read')).map(row => row.id);
  await Promise.all([call('ack', ...observed), ...Array.from({ length: 32 }, (_, i) => call('append', id(i + 32)))]);
  const remaining = JSON.parse(await call('read')).map(row => row.id).sort();
  assert.deepEqual(remaining, Array.from({ length: 32 }, (_, i) => id(i + 32)).sort());
  await call('ack', ...observed); assert.deepEqual(JSON.parse(await call('read')).map(row => row.id).sort(), remaining);
  const now = Date.now(); const date = new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const valid = { widgetAccountScope: 'test-owner', subscriptionEnforced: true, accessUntil: now + 60_000, contentUntil: now + 60_000,
    publishedAtMs: now - 5000, householdCreatedAt: '2026-11-04T00:00:00Z', displayDate: day,
    chores: [{ id: 'row', completed: false, completionGeneration: 7, entry: { id: 'row', householdId: 'local-household' } }] };
  for (const override of [{ accessUntil: now - 1000 }, { accessUntil: null }, { subscriptionLocked: true }, { contentUntil: now - 1 },
    { contentStale: true }, { publishedAtMs: now + 60_000 }, { displayDate: '2000-01-01' }, { widgetAccountScope: '' }, { chores: [] }]) {
    assert.equal(await call('accept', JSON.stringify({ ...valid, ...override })), 'false');
  }
  assert.equal(JSON.parse(await call('read')).length, 32);
  assert.equal(await call('accept', JSON.stringify(valid)), 'true');
  const row = JSON.parse(await call('read')).at(-1); assert.equal(row.completedLocalDate, day); assert.equal(row.accountScope, 'test-owner');
  assert.ok(row.acceptedAtMs >= now && row.acceptedAtMs <= Date.now());
  assert.equal(row.entry.id, 'row'); assert.match(row.id, /^completion-intent\./);
  assert.equal(row.completionGeneration, 7, 'the native writer retains the published Undo generation');
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const field = key => parts.find(row => row.type === key).value; const ownDay = `${field('year')}-${field('month')}-${field('day')}`;
    assert.equal(await call('accept', JSON.stringify({ ...valid, displayTimeZone: zone, displayDate: ownDay })), 'true');
    const own = JSON.parse(await call('read')).at(-1); assert.equal(own.completedLocalDate, ownDay); assert.equal(own.timeZone, zone);
  }
  for (const displayTimeZone of ['Invalid/Zone', '', null, 42]) assert.equal(await call('accept', JSON.stringify({ ...valid, displayTimeZone })), 'false');
  // Per-operation and row-count limits must not produce a file the reader refuses.
  const large = n => { const value = { id: id(n), note: '' }; value.note = 'x'.repeat(24_000 - Buffer.byteLength(JSON.stringify(value))); return value; };
  const beforeFull = JSON.stringify(Array.from({ length: 999 }, (_, i) => large(i)));
  writeFileSync(join(journal, 'inputs.json'), beforeFull);
  const next = large(999);
  await assert.rejects(call('append-payload', next.id, next.note), 'a rejected append leaves the readable prior journal intact');
  assert.equal(readFileSync(join(journal, 'inputs.json'), 'utf8'), beforeFull);
  await call('ack', id(0));
  await call('append-payload', next.id, next.note);
  assert.equal(JSON.parse(await call('read')).length, 999, 'acknowledgement frees capacity without losing the new input');
  // Invalid storage must fail closed rather than being treated as an empty queue.
  writeFileSync(join(journal, 'inputs.json'), '{broken'); await assert.rejects(call('read'));
});
