import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicAnalysisDependencies } from '../server/appliance-care-api/src/public-analysis.mjs';
import { OpenAIResponsesClient } from '../server/appliance-care-api/src/openai-responses-client.mjs';

test('public analysis bounds AI call count and stops all later work after the shared job signal is aborted', async () => {
  const controller = new AbortController(); let calls = 0; let received;
  const deps = createPublicAnalysisDependencies(controller.signal, { createAi: options => {
    received = options;
    return { async createStructured() { calls++; return { value: { status: 'not_found' }, sourceUrls: ['https://www.dyson.co.jp/synthetic'] }; } };
  } });
  const request = { name: 'synthetic', schema: {}, input: [] };
  await deps.analyzeUploaded(request);
  await assert.rejects(deps.analyzeUploaded(request)); assert.equal(calls, 1);
  assert.equal(received.maxOutputTokens, 16_384); assert.equal(received.maxToolCalls, 1);
  controller.abort(); await assert.rejects(deps.analyzeUploaded(request)); assert.equal(calls, 1);
});

test('public OpenAI requests retain the model and schema while enforcing output tool and abort limits without retries', async () => {
  const controller = new AbortController(); let calls = 0; let sent; let requestSignal;
  const client = new OpenAIResponsesClient({ apiKey: 'synthetic-test-only', model: 'gpt-5.5', signal: controller.signal,
    maxOutputTokens: 16_384, maxToolCalls: 5, fetchImpl: async (_url, options) => {
      calls++; sent = JSON.parse(options.body); requestSignal = options.signal; return Response.json({ output_text: '{"ok":true}' });
    } });
  const request = { name: 'synthetic', schema: { type: 'object' }, input: [], tools: [{ type: 'web_search' }], requireTool: true };
  await client.createStructured(request);
  assert.equal(sent.model, 'gpt-5.5'); assert.equal(sent.max_output_tokens, 16_384); assert.equal(sent.max_tool_calls, 5);
  assert.equal(sent.store, false); assert.equal(sent.text.format.strict, true);
  controller.abort(); assert.equal(requestSignal.aborted, true);
  await assert.rejects(client.createStructured(request)); assert.equal(calls, 1);
});

test('only server-observed OpenAI unavailability or no response is refundable while refused or malformed returned analysis stays charged', async () => {
  for (const status of [400, 401, 403, 408, 429, 500, 502, 503]) {
    const client = new OpenAIResponsesClient({ apiKey: 'synthetic', fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(client.createStructured({ input: [], name: 'synthetic', schema: {} }), e => e.providerNoResult === true);
  }
  for (const payload of [{}, { output: [] }, { output: {} }, { output_text: ' \n\t ' },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: ' \t ' }] }] },
    { output: [{ type: 'message', content: {} }] }]) {
    const client = new OpenAIResponsesClient({ apiKey: 'synthetic', fetchImpl: async () => Response.json(payload) });
    await assert.rejects(client.createStructured({ input: [], name: 'synthetic', schema: {} }), e => e.providerNoResult === true);
  }
  for (const payload of [{ output_text: 'not-json' }, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: '合成した拒否' }] }] }]) {
    const client = new OpenAIResponsesClient({ apiKey: 'synthetic', fetchImpl: async () => Response.json(payload) });
    await assert.rejects(client.createStructured({ input: [], name: 'synthetic', schema: {} }), e => e.providerNoResult !== true);
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = new OpenAIResponsesClient({ apiKey: 'synthetic', signal: controller.signal, fetchImpl: async () => { throw new Error('must not start'); } });
  await assert.rejects(cancelled.createStructured({ input: [], name: 'synthetic', schema: {} }), e => e.providerNoResult !== true);
});
