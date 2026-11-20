import { Pool } from 'undici';
import { ANALYSIS_TIMEOUT_MS } from './analysis-delivery-contract.mjs';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-6-luna';
// Use the request and job abort signals as the response deadline. Undici otherwise
// stops waiting for headers or the next body chunk at five minutes.
const openAiDispatcher = new Pool(new URL(RESPONSES_URL).origin, { headersTimeout: 0, bodyTimeout: 0 });

export class OpenAIResponsesClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL, fetchImpl = fetch,
    reasoningEffort = process.env.OPENAI_REASONING_EFFORT ?? (model === DEFAULT_MODEL ? 'max' : undefined),
    signal, maxToolCalls } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort?.trim();
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.maxToolCalls = maxToolCalls;
  }

  get isConfigured() {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  async createStructured({ name, schema, input, tools, requireTool = false }) {
    if (!this.isConfigured) throw new Error('OpenAI API is not configured');
    this.signal?.throwIfAborted();

    const body = {
      model: this.model,
      input,
      store: false,
      ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
      text: { format: { type: 'json_schema', name, strict: true, schema } },
    };
    if (tools?.length) {
      body.tools = tools;
      body.include = ['web_search_call.action.sources'];
      if (requireTool) body.tool_choice = 'required';
      if (this.maxToolCalls) body.max_tool_calls = this.maxToolCalls;
    }

    let response;
    try {
      const deadline = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
      response = await this.fetchImpl(RESPONSES_URL, {
        method: 'POST',
        redirect: 'error',
        dispatcher: openAiDispatcher,
        headers: {
          authorization: 'Bearer ' + this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: this.signal ? AbortSignal.any([this.signal, deadline]) : deadline,
      });
    } catch {
      throw temporaryNetworkError(!this.signal?.aborted);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 408 || response.status === 429 || response.status >= 500) throw temporaryNetworkError(true);
      const error = new Error('OpenAI request failed'); error.providerNoResult = true; throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = temporaryNetworkError(!this.signal?.aborted); error.message = 'OpenAI response was not valid JSON'; throw error;
    }

    if (payload?.status === 'incomplete') {
      if (payload.incomplete_details?.reason === 'content_filter') throw new Error('OpenAI returned no structured output (refused)');
      throw temporaryNetworkError(true);
    }

    const outputText = getOutputText(payload);
    if (!outputText) {
      const refused = Array.isArray(payload?.output) && payload.output.some(item => Array.isArray(item?.content) && item.content.some(part => part?.type === 'refusal'));
      if (refused) throw new Error('OpenAI returned no structured output (refused)');
      throw temporaryNetworkError(true);
    }

    let value;
    try {
      value = JSON.parse(outputText);
    } catch {
      throw new Error('OpenAI structured output was not valid JSON');
    }

    return { value, sourceUrls: getWebSearchSources(payload) };
  }
}

function temporaryNetworkError(providerNoResult = false) {
  const error = new Error('Temporary AI service failure');
  error.code = 'TEMPORARY_NETWORK_ERROR';
  error.providerNoResult = providerNoResult;
  return error;
}

function getOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim().length > 0) return payload.output_text;
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text.trim().length > 0) return content.text;
    }
  }
  return undefined;
}

function getWebSearchSources(payload) {
  const sources = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== 'web_search_call') continue;
    for (const source of Array.isArray(item.action?.sources) ? item.action.sources : []) {
      if (typeof source?.url === 'string') sources.push(source.url);
    }
  }
  return [...new Set(sources)];
}
