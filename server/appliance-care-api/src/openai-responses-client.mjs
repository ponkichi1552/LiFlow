const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export class OpenAIResponsesClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL ?? 'gpt-5.5', fetchImpl = fetch,
    signal, maxOutputTokens, maxToolCalls } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.maxOutputTokens = maxOutputTokens;
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
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      ...(this.maxOutputTokens ? { max_output_tokens: this.maxOutputTokens } : {}),
    };
    if (tools?.length) {
      body.tools = tools;
      body.include = ['web_search_call.action.sources'];
      if (requireTool) body.tool_choice = 'required';
      if (this.maxToolCalls) body.max_tool_calls = this.maxToolCalls;
    }

    let response;
    try {
      response = await this.fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
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
      const error = temporaryNetworkError(true); error.message = 'OpenAI response was not valid JSON'; throw error;
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
  if (typeof payload?.output_text === 'string' && payload.output_text.length > 0) return payload.output_text;
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
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
