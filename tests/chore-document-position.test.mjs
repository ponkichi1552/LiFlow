import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createChoreDocumentPosition } = await import('../src/components/chore-document-position.ts');

test('a chore document indicator includes unmounted chapters and preserves its position when the preceding range is loaded', () => {
  const position = createChoreDocumentPosition();
  const chapters = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, estimate: 400 }));
  const input = { chapters, startId: 'c10', gap: 0, padding: 0 };
  position.update(input);
  const before = position.scroll(100, 800);
  assert.ok(before.progress > 0.5);
  assert.equal(before.fraction, 0.1, 'loading only the latter range must not shorten the represented document');
  const prepended = position.update({ ...input, startId: 'c8' });
  assert.deepEqual(prepended, before);
  assert.deepEqual(position.scroll(900, 800), before, 'the native preserved offset must not move the indicator twice');
  assert.equal(position.jump('c0').progress, 0);
  const expandedCatalog = position.update({ ...input, startId: 'c0', chapters: [...chapters, { id: 'added', estimate: 400 }] });
  assert.ok(expandedCatalog.fraction < before.fraction);
  assert.ok(position.measure('added', 1200).fraction < expandedCatalog.fraction);
});

test('an empty or shorter-than-viewport document never produces invalid scroll positions', () => {
  const position = createChoreDocumentPosition();
  position.update({ chapters: [], startId: '', gap: 24, padding: 20 });
  assert.deepEqual(position.scroll(100, 800), { progress: 0, fraction: 1 });
  position.update({ chapters: [{ id: 'one', estimate: 400 }], startId: 'one', gap: 0, padding: 0 });
  assert.deepEqual(position.scroll(900, 800), { progress: 0, fraction: 1 });
  assert.deepEqual(position.measure('one', NaN), { progress: 0, fraction: 1 });
});
