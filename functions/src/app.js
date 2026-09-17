// HTTP handler for the private AI concierge.
//   POST /session  { user, code }            -> { token, user, expiresAt }
//   POST /ai       { messages, action?, image? } -> { reply, token?, expiresAt? }
//   POST /diary/list          {}                        -> { days }
//   POST /diary/save          { date, text, mood, expenses } -> { day }
//   POST /diary/photo/add     { date, image, caption? }  -> { photo }
//   POST /diary/photo/get     { date, id }               -> { photo }
//   POST /diary/photo/remove  { date, id }               -> { ok }
// Everything except /session needs Authorization: Bearer <token>.
// Errors: { error: { code, message, retryAfterSeconds?, availableFrom? } }
import { createHash } from 'node:crypto';
import { issueToken, verifyToken, secretEquals } from './token.js';
import { validateLogin, validateAiRequest, validateDiaryDay, validateDiaryPhoto, validateDiaryPhotoRef } from './validate.js';
import { DiaryError } from './diary.js';
import { buildSystemPrompt } from './prompt.js';
import { providersForCountries, runWithFallback } from './providers/index.js';
import { ProviderError } from './providers/errors.js';
import { getTripStatus, getAiRegionStatus } from '../shared/trip-core.js';

const MIN_ACCESS_SECRET_LENGTH = 10;
const MIN_SIGNING_SECRET_LENGTH = 32;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const tooMany = (retryAfterSeconds, message = 'Zu viele Anfragen – bitte kurz warten.') =>
  new HttpError(429, 'rate_limited', message, { retryAfterSeconds });

export function createHandler({ config, getSecrets, providers, limiter, loadTripData, diary, now = () => Date.now(), log = console }) {
  const sessionOpts = () => ({ now: now(), users: config.users, maxAgeSeconds: config.session.maxAgeSeconds });

  function secrets() {
    const s = getSecrets();
    if ((s.COUPLE_ACCESS_SECRET || '').length < MIN_ACCESS_SECRET_LENGTH || (s.SESSION_SIGNING_SECRET || '').length < MIN_SIGNING_SECRET_LENGTH) {
      log.error('misconfigured: COUPLE_ACCESS_SECRET / SESSION_SIGNING_SECRET missing or too short');
      throw new HttpError(500, 'misconfigured', 'Der AI Concierge ist noch nicht fertig eingerichtet.');
    }
    return s;
  }

  async function enforce(key, rule, message) {
    const r = await limiter.hit(key, rule, now());
    if (!r.allowed) throw tooMany(r.retryAfterSeconds, message);
  }

  function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.ip || 'unknown';
  }

  async function handleSession(req) {
    const ipKey = `login_ip_${createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 32)}`;
    await enforce(ipKey, config.rateLimits.loginPerIp, 'Zu viele Anmeldeversuche – bitte in ein paar Minuten erneut versuchen.');
    const global = await limiter.peek('login_fail_global', config.rateLimits.loginFailuresGlobal, now());
    if (!global.allowed) throw tooMany(global.retryAfterSeconds, 'Anmeldung vorübergehend gesperrt – bitte später erneut versuchen.');

    const v = validateLogin(req.body, { users: config.users });
    if (!v.ok) throw new HttpError(400, v.code, v.message);

    const s = secrets();
    if (!secretEquals(v.value.code, s.COUPLE_ACCESS_SECRET)) {
      await limiter.hit('login_fail_global', config.rateLimits.loginFailuresGlobal, now());
      log.warn('login failed', { user: v.value.user });
      throw new HttpError(401, 'wrong_code', 'Der Zugangscode ist nicht korrekt.');
    }

    const { token, expiresAt } = issueToken(
      { user: v.value.user, now: now(), ttlSeconds: config.session.ttlSeconds, maxAgeSeconds: config.session.maxAgeSeconds },
      s.SESSION_SIGNING_SECRET,
    );
    log.info('login ok', { user: v.value.user });
    return { status: 200, body: { token, user: v.value.user, expiresAt } };
  }

  /** Every endpoint but /session goes through here; the token decides who is acting. */
  function requireSession(req) {
    const auth = String(req.headers.authorization || '');
    const session = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7), secrets().SESSION_SIGNING_SECRET, sessionOpts()) : null;
    if (!session) throw new HttpError(401, 'unauthorized', 'Bitte erneut entsperren.');
    return session;
  }

  async function handleAi(req) {
    // 1. session
    const s = secrets();
    const session = requireSession(req);

    // 2. payload + prompt length
    const v = validateAiRequest(req.body, config.limits);
    if (!v.ok) throw new HttpError(v.code === 'prompt_too_long' || v.code === 'image_too_large' ? 413 : 400, v.code, v.message);

    // 3. region (official availability of the provider where the itinerary says we are)
    const t = now();
    const trip = await loadTripData(t);
    const status = getTripStatus(trip, new Date(t));
    const countries = status.phase === 'during' ? [...new Set(status.current.map((c) => c.country))] : ['CH'];
    const eligible = providersForCountries(providers, countries);
    if (eligible.length === 0) {
      const supported = [...new Set(providers.flatMap((p) => p.supportedCountries))];
      const region = getAiRegionStatus(trip, new Date(t), supported);
      throw new HttpError(503, 'region_unavailable', 'Der AI Concierge ist in dieser Region offiziell nicht verfügbar.', {
        availableFrom: region.availableFrom,
      });
    }

    // 4. rate limits
    const rl = config.rateLimits;
    await enforce(`ai_${session.u}_burst`, rl.aiPerUserBurst);
    await enforce(`ai_${session.u}_day`, rl.aiPerUserDay, 'Tageslimit für AI-Fragen erreicht – morgen geht es weiter.');
    await enforce('ai_global_day', rl.aiGlobalDay, 'Tageslimit für AI-Fragen erreicht – morgen geht es weiter.');

    // 5. provider
    const started = Date.now();
    let result;
    try {
      result = await runWithFallback(eligible, {
        system: buildSystemPrompt(trip, t, session.u, v.value.action),
        messages: v.value.messages,
        image: v.value.image,
        maxOutputTokens: config.limits.maxOutputTokens,
        timeoutMs: config.limits.providerTimeoutMs,
      });
    } catch (err) {
      throw providerHttpError(err, log);
    }
    // Log metadata only – never the chat content.
    log.info('ai ok', { user: session.u, action: v.value.action, withImage: Boolean(v.value.image), provider: result.provider, ms: Date.now() - started, usage: result.usage });

    const body = { reply: result.text };
    const nowSec = Math.floor(t / 1000);
    if (nowSec - session.iat >= config.session.refreshAfterSeconds) {
      Object.assign(body, issueToken(
        { user: session.u, authTime: session.at, now: t, ttlSeconds: config.session.ttlSeconds, maxAgeSeconds: config.session.maxAgeSeconds },
        s.SESSION_SIGNING_SECRET,
      ));
    }
    return { status: 200, body };
  }

  // ---------- diary ----------
  // The diary of the logged-in user, always. A request cannot name a different one.
  async function diaryWrite(req) {
    const session = requireSession(req);
    await enforce(`diary_${session.u}_day`, config.rateLimits.diaryPerUserDay, 'Tageslimit für Tagebuch-Änderungen erreicht.');
    return session;
  }

  const badRequest = (v) => new HttpError(
    v.code === 'entry_too_long' || v.code === 'image_too_large' ? 413 : 400,
    v.code,
    v.message,
  );

  async function handleDiaryList(req) {
    const session = requireSession(req);
    return { status: 200, body: { days: await diary.list(session.u) } };
  }

  async function handleDiarySave(req) {
    const session = await diaryWrite(req);
    const v = validateDiaryDay(req.body, config.limits);
    if (!v.ok) throw badRequest(v);
    log.info('diary saved', { user: session.u, date: v.value.date });
    return { status: 200, body: { day: await diary.save(session.u, v.value) } };
  }

  async function handleDiaryPhotoAdd(req) {
    const session = await diaryWrite(req);
    const v = validateDiaryPhoto(req.body, config.limits);
    if (!v.ok) throw badRequest(v);
    try {
      const photo = await diary.addPhoto(session.u, v.value);
      log.info('diary photo added', { user: session.u, date: v.value.date });
      return { status: 200, body: { photo } };
    } catch (err) {
      if (err instanceof DiaryError) throw new HttpError(409, err.code, err.message);
      throw err;
    }
  }

  async function handleDiaryPhotoGet(req) {
    const session = requireSession(req);
    const v = validateDiaryPhotoRef(req.body);
    if (!v.ok) throw badRequest(v);
    const photo = await diary.getPhoto(session.u, v.value);
    if (!photo) throw new HttpError(404, 'not_found', 'Foto nicht gefunden.');
    return { status: 200, body: { photo } };
  }

  async function handleDiaryPhotoRemove(req) {
    const session = await diaryWrite(req);
    const v = validateDiaryPhotoRef(req.body);
    if (!v.ok) throw badRequest(v);
    if (!await diary.removePhoto(session.u, v.value)) throw new HttpError(404, 'not_found', 'Foto nicht gefunden.');
    return { status: 200, body: { ok: true } };
  }

  const routes = {
    '/session': handleSession,
    '/ai': handleAi,
    '/diary/list': handleDiaryList,
    '/diary/save': handleDiarySave,
    '/diary/photo/add': handleDiaryPhotoAdd,
    '/diary/photo/get': handleDiaryPhotoGet,
    '/diary/photo/remove': handleDiaryPhotoRemove,
  };

  return async function handler(req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');

    const origin = req.headers.origin;
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Origin not allowed.' } });
      }
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }

    try {
      const route = routes[req.path];
      if (!route) throw new HttpError(404, 'not_found', 'Unbekannter Endpunkt.');
      if (req.method !== 'POST') {
        res.set('Allow', 'POST, OPTIONS');
        throw new HttpError(405, 'method_not_allowed', 'Nur POST ist erlaubt.');
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw new HttpError(415, 'unsupported_media_type', 'Content-Type muss application/json sein.');
      }
      const size = req.rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body ?? ''));
      if (size > config.limits.maxBodyBytes) throw new HttpError(413, 'payload_too_large', 'Anfrage zu groß.');

      const out = await route(req);
      return res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.extra.retryAfterSeconds) res.set('Retry-After', String(err.extra.retryAfterSeconds));
        return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
      }
      log.error('unhandled error', err);
      return res.status(500).json({ error: { code: 'internal', message: 'Interner Fehler.' } });
    }
  };
}

function providerHttpError(err, log) {
  const kind = err instanceof ProviderError ? err.kind : 'unavailable';
  log.warn('ai provider error', { kind, message: String(err?.message ?? err) });
  switch (kind) {
    case 'timeout':
      return new HttpError(504, 'ai_timeout', 'Der AI Concierge hat nicht rechtzeitig geantwortet.');
    case 'rate_limited':
      return new HttpError(429, 'ai_busy', 'Der AI Concierge ist gerade ausgelastet – bitte gleich nochmal versuchen.', { retryAfterSeconds: 60 });
    case 'misconfigured':
      log.error('AI provider misconfigured', String(err?.message ?? err));
      return new HttpError(500, 'ai_misconfigured', 'Der AI Concierge ist nicht korrekt eingerichtet.');
    case 'rejected':
      return new HttpError(502, 'ai_rejected', 'Diese Anfrage konnte nicht beantwortet werden. Bitte anders formulieren.');
    default:
      return new HttpError(503, 'ai_unavailable', 'Der AI Concierge ist momentan nicht verfügbar.');
  }
}
