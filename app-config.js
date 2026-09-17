// Public frontend configuration. NOTHING in here is secret – the Gemini key and the
// access code live only on the backend (Google Cloud Secret Manager).

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const params = new URLSearchParams(location.search);

// Our own backend (Firebase Cloud Functions, Zürich). The PWA never talks to Gemini directly.
export const AI_API_BASE = (isLocal && params.get('api')) || 'https://europe-west6-asia-2026-tagebuch.cloudfunctions.net/api';

export const AI_CLIENT_TIMEOUT_MS = 15000; // hard stop for a question – no endless spinner
export const AI_LOGIN_TIMEOUT_MS = 10000;
export const AI_HISTORY_MESSAGES = 10; // previous chat turns sent along with a question

// UX hint only (the backend decides): where the configured AI provider is officially available.
export const AI_SUPPORTED_COUNTRIES = ['CH', 'IT', 'JP'];

/** Current time; on localhost `?now=2026-10-07T03:00:00Z` simulates a trip day for testing. */
export function appNow() {
  const fake = isLocal && params.get('now');
  return fake ? new Date(fake) : new Date();
}
