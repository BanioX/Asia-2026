// AI provider layer. The HTTP handler only talks to this module.
// To add a (China-compatible) fallback later: write an adapter with the same shape as
// gemini.js ({ name, supportedCountries, generate() }), register it below and set
// AI_PROVIDER_FALLBACK=<name>. The PWA does not change.
import { createGeminiProvider } from './gemini.js';
import { ProviderError } from './errors.js';

const factories = {
  gemini: (opts) => createGeminiProvider({ apiKey: opts.secrets.GEMINI_API_KEY, model: opts.config.geminiModel }),
};

export function createProviders({ config, secrets }) {
  const names = [config.aiProvider, config.aiProviderFallback].filter(Boolean);
  return names.map((name) => {
    const factory = factories[name];
    if (!factory) throw new Error(`Unknown AI provider: ${name}`);
    return factory({ config, secrets });
  });
}

/** Providers that are officially available in every one of the given countries. */
export function providersForCountries(providers, countries) {
  return providers.filter((p) => countries.every((c) => p.supportedCountries.includes(c)));
}

/** Try providers in order; move on to the next one only for retryable failures. */
export async function runWithFallback(providers, request) {
  let lastError = new ProviderError('unavailable', 'No AI provider configured');
  for (const provider of providers) {
    try {
      const result = await provider.generate(request);
      return { ...result, provider: provider.name };
    } catch (err) {
      lastError = err instanceof ProviderError ? err : new ProviderError('unavailable', String(err?.message ?? err), { cause: err });
      if (!lastError.retryable) break;
    }
  }
  throw lastError;
}
