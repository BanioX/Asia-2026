// Firebase Cloud Functions (2nd gen) entry point.
// Public URL: https://europe-west6-asia-2026-tagebuch.cloudfunctions.net/api/{session|ai}
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import bundledTripData from './shared/trip-data.json' with { type: 'json' };
import { config } from './src/config.js';
import { createHandler } from './src/app.js';
import { createProviders } from './src/providers/index.js';
import { FirestoreRateLimiter } from './src/ratelimit.js';
import { createTripDataLoader } from './src/tripData.js';

// Values live in Google Cloud Secret Manager (set by Alban via the Firebase CLI).
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const COUPLE_ACCESS_SECRET = defineSecret('COUPLE_ACCESS_SECRET');
const SESSION_SIGNING_SECRET = defineSecret('SESSION_SIGNING_SECRET');

initializeApp();

const getSecrets = () => ({
  GEMINI_API_KEY: GEMINI_API_KEY.value(),
  COUPLE_ACCESS_SECRET: COUPLE_ACCESS_SECRET.value(),
  SESSION_SIGNING_SECRET: SESSION_SIGNING_SECRET.value(),
});

let handler;
function getHandler() {
  // Secrets are only readable at runtime, so the handler is built on the first request.
  handler ??= createHandler({
    config,
    getSecrets,
    providers: createProviders({ config, secrets: getSecrets() }),
    limiter: new FirestoreRateLimiter(getFirestore()),
    loadTripData: createTripDataLoader({ url: config.tripDataUrl, bundled: bundledTripData }),
  });
  return handler;
}

export const api = onRequest(
  {
    region: config.region,
    secrets: [GEMINI_API_KEY, COUPLE_ACCESS_SECRET, SESSION_SIGNING_SECRET],
    invoker: 'public', // reachable from the PWA; access is checked inside (session token)
    cors: false, // CORS is handled in src/app.js (allowlist)
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 3, // hard ceiling against runaway traffic
    concurrency: 20,
  },
  (req, res) => getHandler()(req, res),
);
