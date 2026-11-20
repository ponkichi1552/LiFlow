import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIResponsesClient } from '../server/appliance-care-api/src/openai-responses-client.mjs';

const request = { name: 'synthetic_result', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, input: [] };

for (const status of [400, 401, 403, 408, 429, 500, 502, 503]) {
  test(`OpenAI HTTP ${status} releases the error body without exposing it or repeating a paid request`, async () => {
    let calls = 0; let cancelled = 0; let read = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { read++; controller.enqueue(new TextEncoder().encode('synthetic-private-server-detail')); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status });
    const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', model: 'gpt-5.5', fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(client.createStructured(request), (error) => {
      assert.equal(error.code === 'TEMPORARY_NETWORK_ERROR', status === 408 || status === 429 || status >= 500);
      assert.ok(!error.message.includes('synthetic-private-server-detail'));
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
    assert.equal(read, 0);
  });
}

for (const kind of ['no body', 'cancel failure']) {
  test(`OpenAI error classification survives ${kind} during response cleanup`, async () => {
    const body = kind === 'no body' ? null : new ReadableStream({ cancel() { throw new Error('synthetic-sensitive-cancel-error'); } });
    const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', fetchImpl: async () => new Response(body, { status: 429 }) });
    await assert.rejects(client.createStructured(request), (error) => error.code === 'TEMPORARY_NETWORK_ERROR' && !error.message.includes('synthetic-sensitive'));
  });
}

test('an unconfigured OpenAI client never opens a request', async () => {
  let calls = 0;
  const client = new OpenAIResponsesClient({ apiKey: '', fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(client.isConfigured, false);
  await assert.rejects(client.createStructured(request), /not configured/);
  assert.equal(calls, 0);
});

test('OpenAI transport failures preserve the retry classification and hide transport details', async () => {
  const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', fetchImpl: async () => { throw new Error('synthetic-sensitive-transport-detail'); } });
  await assert.rejects(client.createStructured(request), (error) => error.code === 'TEMPORARY_NETWORK_ERROR' && !error.message.includes('synthetic-sensitive'));
});

for (const [label, body, message] of [
  ['invalid HTTP JSON', '{', /response was not valid JSON/],
  ['missing structured content', JSON.stringify({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'refusal', refusal: 'synthetic refusal' }] }] }), /no structured output/],
  ['invalid structured JSON', JSON.stringify({ output_text: '{' }), /structured output was not valid JSON/],
]) {
  test(`OpenAI client rejects ${label} instead of producing an accepted analysis`, async () => {
    const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', fetchImpl: async () => new Response(body) });
    await assert.rejects(client.createStructured(request), message);
  });
}

test('OpenAI client preserves alternate text output, source deduplication and a request without tools', async () => {
  let sent;
  const url = 'https://www.dyson.co.jp/support';
  const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', model: 'gpt-5.5', reasoningEffort: '', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ output_text: '{"ok":true}', output: [
      { type: 'web_search_call', action: { sources: [{ url }, { url }, { title: 'without URL' }] } },
      { type: 'web_search_call' },
    ] }));
  } });
  assert.deepEqual(await client.createStructured(request), { value: { ok: true }, sourceUrls: [url] });
  assert.equal(sent.model, 'gpt-5.5'); assert.equal(sent.store, false);
  assert.equal(sent.tools, undefined); assert.equal(sent.tool_choice, undefined);
  assert.equal(sent.reasoning, undefined);
  assert.equal(sent.text.format.strict, true);
});

test('OpenAI client sends the configured GPT-6 Luna model and max reasoning effort as separate parameters', async () => {
  let sent;
  const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', model: 'gpt-6-luna', reasoningEffort: ' max ',
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return Response.json({ output_text: '{"ok":true}' });
    } });
  await client.createStructured(request);
  assert.equal(sent.model, 'gpt-6-luna');
  assert.deepEqual(sent.reasoning, { effort: 'max' });
  assert.equal(sent.store, false);
});

test('an unconfigured server model defaults to GPT-6 Luna with max effort', async t => {
  const settings = ['OPENAI_MODEL', 'OPENAI_REASONING_EFFORT'];
  for (const setting of settings) {
    const original = process.env[setting];
    t.after(() => { if (original !== undefined) process.env[setting] = original; });
    delete process.env[setting];
  }
  let sent;
  const client = new OpenAIResponsesClient({ apiKey: 'test-only-key', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ output_text: '{"ok":true}' });
  } });
  await client.createStructured(request);
  assert.equal(sent.model, 'gpt-6-luna');
  assert.deepEqual(sent.reasoning, { effort: 'max' });
});
