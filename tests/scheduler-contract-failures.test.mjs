import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreviousSchedulerContract } from '../scripts/check-shared-scheduler-version.mjs';

test('scheduler compatibility permits only a verified absent prior contract and fails closed on unreadable Git or corrupt JSON', () => {
  const file = 'src/features/sharing/v2/scheduler-contract.json'; const body = { version: 'liflow-shared-2-draft-47' };
  const commands = [];
  const runner = (paths = file, raw = JSON.stringify(body), fails = '') => args => {
    commands.push(args);
    if (args[0] === fails) throw new Error('git object unavailable');
    return args[0] === 'ls-tree' ? `${paths}\n` : args[0] === 'show' ? raw : 'verified-commit';
  };
  assert.equal(readPreviousSchedulerContract('base', file, runner('')), undefined);
  assert.deepEqual(readPreviousSchedulerContract('base', file, runner()), body);
  for (const command of ['rev-parse', 'ls-tree', 'show']) assert.throws(() => readPreviousSchedulerContract('base', file, runner(file, '{}', command)), /unavailable/);
  assert.throws(() => readPreviousSchedulerContract('base', file, runner(file, '{corrupted-json')), SyntaxError);
  assert.throws(() => readPreviousSchedulerContract('base', file, runner('other-path')), /path/);
  assert.ok(commands.some(args => args[0] === 'rev-parse' && args[2] === 'base^{commit}'));
});
