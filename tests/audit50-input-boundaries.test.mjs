import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTasksApi, GoogleTasksApiError } from '../src/platform/google-tasks/google-tasks-api.ts';

test('audit50 Tasks direct replies must retain the requested identity before adoption or completion processing', async () => {
  const api = createGoogleTasksApi(async () => Response.json({ id: 'another-task', title: 'another', status: 'completed', completed: '2026-11-07T00:00:00Z' }));
  await assert.rejects(api.getTask('test', 'list', 'expected-task'), error => error instanceof GoogleTasksApiError && error.status === 502);
  await assert.rejects(api.patchTask('test', 'list', 'expected-task', { status: 'completed' }), error => error instanceof GoogleTasksApiError && error.status === 502);
});
