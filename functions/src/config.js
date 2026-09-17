// Non-secret backend configuration. Secrets (GEMINI_API_KEY, COUPLE_ACCESS_SECRET,
// SESSION_SIGNING_SECRET) live ONLY in Google Cloud Secret Manager – never here.
// Plain env vars can override the defaults below if ever needed.

const env = process.env;

export const config = {
  region: 'europe-west6', // Zürich

  // AI provider selection (see src/providers/). Fallback is optional and empty for now.
  aiProvider: env.AI_PROVIDER || 'gemini',
  aiProviderFallback: env.AI_PROVIDER_FALLBACK || '',
  geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',

  // Only these origins may call the API from a browser.
  allowedOrigins: (env.ALLOWED_ORIGINS || 'https://baniox.github.io').split(',').map((s) => s.trim()).filter(Boolean),

  // Live itinerary (same file the PWA uses); bundled copy is the fallback.
  tripDataUrl: env.TRIP_DATA_URL || 'https://baniox.github.io/Asia-2026/trip-data.json',

  users: ['alban', 'deshira'],

  session: {
    ttlSeconds: 7 * 24 * 3600, // token valid 7 days …
    refreshAfterSeconds: 24 * 3600, // … and re-issued on use once it is older than a day …
    maxAgeSeconds: 31 * 24 * 3600, // … but a fresh login is required after 31 days at the latest.
  },

  limits: {
    maxBodyBytes: 3 * 1024 * 1024, // a question may carry one inline (base64) photo
    maxPromptChars: 1000, // the new question
    maxHistoryMessages: 10, // previous turns sent along (client trims to this as well)
    maxHistoryMessageChars: 4000,
    maxTotalChars: 20000,
    maxImageBase64Chars: 1_400_000, // ~1 MB JPEG; the app downscales before sending
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxDiaryTextChars: 4000,
    maxDiaryExpenses: 25,
    maxDiaryPhotosPerDay: 20,
    maxOutputTokens: 1024,
    providerTimeoutMs: 12000,
  },

  rateLimits: {
    aiPerUserBurst: { limit: 15, windowSeconds: 10 * 60 },
    aiPerUserDay: { limit: 120, windowSeconds: 24 * 3600 },
    aiGlobalDay: { limit: 250, windowSeconds: 24 * 3600 },
    diaryPerUserDay: { limit: 400, windowSeconds: 24 * 3600 },
    loginPerIp: { limit: 8, windowSeconds: 15 * 60 },
    loginFailuresGlobal: { limit: 40, windowSeconds: 3600 },
  },
};
