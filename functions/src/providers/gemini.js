// Gemini adapter – official Gemini API via @google/genai (Interactions API).
// Docs checked 2026-09-17: https://ai.google.dev/gemini-api/docs/interactions
import { GoogleGenAI } from '@google/genai';
import { ProviderError } from './errors.js';

// Allowlist from https://ai.google.dev/gemini-api/docs/available-regions (checked 2026-09-17).
// Only the countries on this trip are listed; mainland China (CN) and Hong Kong (HK) are NOT supported.
// Italy re-checked 2026-09-17 (Rome leg added): listed as available.
const SUPPORTED_COUNTRIES = ['CH', 'IT', 'JP'];

export function createGeminiProvider({ apiKey, model, client }) {
  const ai = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);

  return {
    name: 'gemini',
    model,
    supportedCountries: SUPPORTED_COUNTRIES,

    async generate({ system, messages, image, maxOutputTokens, timeoutMs }) {
      if (!ai) throw new ProviderError('misconfigured', 'GEMINI_API_KEY is not set');

      const input = messages.map((m) => ({
        type: m.role === 'user' ? 'user_input' : 'model_output',
        content: [{ type: 'text', text: m.text }],
      }));

      // An inline photo belongs to the newest question.
      // Part format per https://ai.google.dev/gemini-api/docs/image-understanding (checked 2026-09-17).
      if (image && input.length) {
        input[input.length - 1].content.push({ type: 'image', data: image.data, mime_type: image.mimeType });
      }

      let res;
      try {
        res = await ai.interactions.create(
          {
            model,
            input,
            system_instruction: system,
            store: false, // don't keep chats on Google's side
            generation_config: { max_output_tokens: maxOutputTokens, thinking_level: 'low' },
          },
          { timeout_ms: timeoutMs, retries: { strategy: 'none' } },
        );
      } catch (err) {
        throw mapError(err);
      }

      const text = (res.output_text ?? extractText(res.steps)).trim();
      if (!text) {
        throw new ProviderError('unavailable', `Gemini returned no text (status: ${res.status})`, { retryable: true });
      }
      return { text, usage: res.usage ?? null };
    },
  };
}

function extractText(steps = []) {
  return steps
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

export function mapError(err) {
  if (err instanceof ProviderError) return err;
  const name = err?.name ?? '';
  const status = err?.status ?? err?.statusCode;
  const message = String(err?.message ?? err);

  if (name === 'RequestTimeoutError' || name === 'RequestAbortedError' || name === 'AbortError' || name === 'TimeoutError') {
    return new ProviderError('timeout', 'Gemini timed out', { cause: err, retryable: true });
  }
  if (name === 'ConnectionError' || (!status && /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message))) {
    return new ProviderError('unavailable', 'Gemini not reachable', { cause: err, retryable: true });
  }
  if (status === 429) return new ProviderError('rate_limited', 'Gemini quota/rate limit reached', { cause: err, retryable: true });
  if (status === 401 || status === 403) return new ProviderError('misconfigured', `Gemini auth failed (${status})`, { cause: err });
  if (status === 400 && /location is not supported/i.test(message)) {
    return new ProviderError('unavailable', 'Gemini not available in this region', { cause: err, retryable: true });
  }
  if (status >= 500) return new ProviderError('unavailable', `Gemini server error (${status})`, { cause: err, retryable: true });
  if (status === 404) return new ProviderError('misconfigured', 'Gemini model not found', { cause: err });
  return new ProviderError('rejected', `Gemini rejected the request (${status ?? name})`, { cause: err });
}
