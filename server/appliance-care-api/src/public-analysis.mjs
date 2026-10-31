import { OpenAIResponsesClient } from './openai-responses-client.mjs';

/** Fixed per-job ceilings supplement admission counts; no automatic retries of paid requests. */
export function createPublicAnalysisDependencies(signal, { createAi = options => new OpenAIResponsesClient(options) } = {}) {
  const client = createAi({ signal, maxOutputTokens: 16_384, maxToolCalls: 1 });
  let calls = 0;
  const ai = { async createStructured(request) {
    signal.throwIfAborted();
    if (++calls > 1) throw new Error('Public analysis AI call budget exhausted');
    return client.createStructured(request);
  } };
  return { analyzeUploaded: request => {
    if (request.tools?.length || request.input.some(item => item.content?.some(part => part.file_url || part.type === 'input_file' && !part.file_data))) {
      throw new Error('Only uploaded PDF analysis is allowed');
    }
    return ai.createStructured(request);
  } };
}
