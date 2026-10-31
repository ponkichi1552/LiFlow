import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { guideCatalogSelection, unifiedGuideCatalog } from '../src/features/chores/guide-catalog.ts';

const chore = (id, name = '浴室全体を掃除する', extra = {}) => ({ id, name, enabled: true, archived: false, ...extra });
test('unified guides show one common chore, restore the original personal source when shared work is inactive, and never rewrite either source', () => {
  const personal = [chore('p', undefined, { userIntervalDays: 17 })];
  const shared = [chore('s', undefined, { userIntervalDays: 7 })];
  const before = structuredClone({ personal, shared });
  const active = unifiedGuideCatalog(shared, personal);
  assert.deepEqual(active.map(row => [row.id, row.userIntervalDays]), [['shared:s', 7]]);
  assert.equal(guideCatalogSelection(active, 'personal', personal[0]), 'shared:s');
  const inactive = unifiedGuideCatalog([{ ...shared[0], enabled: false }], personal);
  assert.deepEqual(inactive.map(row => [row.id, row.userIntervalDays]), [['personal:p', 17]]);
  assert.equal(guideCatalogSelection(inactive, 'shared', shared[0]), 'personal:p');
  assert.deepEqual({ personal, shared }, before);
  assert.deepEqual(unifiedGuideCatalog([{ ...shared[0], archived: true }], personal), inactive);
});
test('unified guides preserve ambiguous definitions and namespace IDs while matching the same normalized name', () => {
  const p = chore('same', ' 浴室全体を掃除する '); const s = chore('same');
  assert.deepEqual(unifiedGuideCatalog([s], [p]).map(row => row.id), ['shared:same']);
  const ambiguous = unifiedGuideCatalog([s, chore('second')], [p]);
  assert.deepEqual(ambiguous.map(row => row.id), ['shared:same', 'shared:second', 'personal:same']);
  assert.equal(guideCatalogSelection(ambiguous, 'personal', p), 'personal:same');
  assert.equal(guideCatalogSelection(ambiguous, 'personal', chore('missing')), undefined);
  assert.deepEqual(unifiedGuideCatalog([s], [chore('same', '別の家事')]).map(row => row.id), ['shared:same', 'personal:same']);
});
