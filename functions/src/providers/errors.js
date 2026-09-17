// Provider-neutral errors. Adapters translate their SDK errors into these so the
// HTTP layer (and the PWA) never has to know which AI provider is behind /ai.

export class ProviderError extends Error {
  /**
   * @param {'timeout'|'unavailable'|'rate_limited'|'rejected'|'misconfigured'} kind
   */
  constructor(kind, message, { cause, retryable = false } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.kind = kind;
    // retryable = worth trying the fallback provider (if one is configured)
    this.retryable = retryable;
  }
}
