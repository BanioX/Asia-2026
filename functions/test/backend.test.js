import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../src/app.js';
import { config } from '../src/config.js';
import { issueToken, verifyToken, secretEquals } from '../src/token.js';
import { validateAiRequest } from '../src/validate.js';
import { createDiary } from '../src/diary.js';
import { MemoryRateLimiter } from '../src/ratelimit.js';
import { createGeminiProvider, mapError } from '../src/providers/gemini.js';
import { runWithFallback } from '../src/providers/index.js';
import { ProviderError } from '../src/providers/errors.js';
import { createTripDataLoader } from '../src/tripData.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { getTripStatus, getAiRegionStatus, buildTravelContext } from '../shared/trip-core.js';

const trip = JSON.parse(readFileSync(new URL('../shared/trip-data.json', import.meta.url), 'utf8'));
// Obviously fake test values – real secrets exist only in Secret Manager.
const SECRETS = {
  GEMINI_API_KEY: 'fake',
  COUPLE_ACCESS_SECRET: 'test-access-code-123',
  SESSION_SIGNING_SECRET: 'test-signing-secret-0123456789abcdef-xyz',
};
const ORIGIN = 'https://baniox.github.io';
const at = (iso) => Date.parse(iso);
const KYOTO_DAY = at('2026-10-07T03:00:00Z'); // 12:00 in Kyoto
const BEIJING_DAY = at('2026-09-27T04:00:00Z');
const silentLog = { info() {}, warn() {}, error() {} };

/** Enough Firestore for the diary: doc get/set(merge) and a single where(). */
function fakeDb() {
  const docs = new Map();
  return {
    docs,
    collection: (name) => ({
      doc: (id) => {
        const key = name + '/' + id;
        return {
          async get() { const d = docs.get(key); return { exists: Boolean(d), data: () => d && { ...d } }; },
          async set(value, opts) { docs.set(key, opts?.merge ? { ...(docs.get(key) || {}), ...value } : { ...value }); },
        };
      },
      where: (field, _op, val) => ({
        async get() {
          const hits = [...docs.entries()]
            .filter(([k, d]) => k.startsWith(name + '/') && d[field] === val)
            .map(([, d]) => ({ data: () => ({ ...d }) }));
          return { docs: hits };
        },
      }),
    }),
  };
}

/** Enough Cloud Storage for the diary. */
function fakeBucket() {
  const files = new Map();
  return {
    files,
    file: (path) => ({
      async save(buf, opts) { files.set(path, { buf, contentType: opts?.contentType }); },
      async exists() { return [files.has(path)]; },
      async download() { return [files.get(path).buf]; },
      async delete() { if (!files.delete(path)) throw new Error('no such file'); },
    }),
  };
}

function fakeProvider(impl, supportedCountries = ['CH', 'IT', 'JP']) {
  const calls = [];
  return {
    name: 'fake',
    supportedCountries,
    calls,
    async generate(req) {
      calls.push(req);
      return impl(req);
    },
  };
}

function setup({ now = KYOTO_DAY, provider = fakeProvider(() => ({ text: 'Antwort', usage: null })), secrets = SECRETS } = {}) {
  let clock = now;
  const db = fakeDb();
  const bucket = fakeBucket();
  const diary = createDiary({ db, bucket, limits: config.limits, now: () => clock });
  const handler = createHandler({
    diary,
    config,
    getSecrets: () => secrets,
    providers: [provider],
    limiter: new MemoryRateLimiter(),
    loadTripData: async () => trip,
    now: () => clock,
    log: silentLog,
  });
  async function call({ path, method = 'POST', body, headers = {} }) {
    const req = {
      path,
      method,
      body,
      rawBody: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
      ip: '203.0.113.7',
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    };
    const res = {
      statusCode: 0, headers: {}, body: undefined,
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; },
    };
    await handler(req, res);
    return res;
  }
  const login = (user = 'deshira', code = SECRETS.COUPLE_ACCESS_SECRET) => call({ path: '/session', body: { user, code } });
  const ask = (token, body = { messages: [{ role: 'user', text: 'Was machen wir heute?' }] }) =>
    call({ path: '/ai', body, headers: { authorization: `Bearer ${token}` } });
  return { call, login, ask, provider, diary, db, bucket, setClock: (t) => { clock = t; } };
}

describe('login', () => {
  test('Alban login', async () => {
    const res = await setup().login('alban');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user, 'alban');
    assert.match(res.body.token, /^v1\./);
  });

  test('Deshira login (case-insensitive name)', async () => {
    const res = await setup().login('Deshira');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user, 'deshira');
  });

  test('wrong access code', async () => {
    const res = await setup().login('deshira', 'falsch-falsch');
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, 'wrong_code');
    assert.equal(res.body.token, undefined);
  });

  test('unknown user is rejected', async () => {
    const res = await setup().login('mallory');
    assert.equal(res.statusCode, 400);
  });

  test('login attempts per IP are rate limited', async () => {
    const s = setup();
    for (let i = 0; i < config.rateLimits.loginPerIp.limit; i++) await s.login('alban', 'wrong-code-xx');
    const res = await s.login('alban');
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['retry-after']);
  });

  test('global failure lockout also applies to other IPs', async () => {
    const s = setup();
    for (let i = 0; i < config.rateLimits.loginFailuresGlobal.limit; i++) {
      await s.call({ path: '/session', body: { user: 'alban', code: 'nope-nope' }, headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    }
    const res = await s.call({ path: '/session', body: { user: 'alban', code: SECRETS.COUPLE_ACCESS_SECRET }, headers: { 'x-forwarded-for': '192.0.2.99' } });
    assert.equal(res.statusCode, 429);
  });

  test('fails closed when secrets are missing or weak', async () => {
    const res = await setup({ secrets: { ...SECRETS, COUPLE_ACCESS_SECRET: 'short' } }).login('alban', 'short');
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'misconfigured');
  });
});

describe('session', () => {
  test('token works for follow-up questions without re-login', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    assert.equal((await s.ask(token)).statusCode, 200);
    assert.equal((await s.ask(token)).statusCode, 200);
  });

  test('missing / forged / expired token -> 401', async () => {
    const s = setup();
    assert.equal((await s.ask('')).statusCode, 401);
    const { token } = (await s.login()).body;
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await s.ask(forged)).statusCode, 401);
    const otherKey = issueToken({ user: 'alban', now: KYOTO_DAY, ttlSeconds: 3600, maxAgeSeconds: 7200 }, 'x'.repeat(40)).token;
    assert.equal((await s.ask(otherKey)).statusCode, 401);
    s.setClock(KYOTO_DAY + 8 * 24 * 3600 * 1000);
    assert.equal((await s.ask(token)).statusCode, 401);
  });

  test('token is refreshed after a day but never beyond max age', async () => {
    const s = setup({ now: at('2026-09-20T10:00:00Z') });
    const { token } = (await s.login()).body;
    s.setClock(at('2026-09-22T10:00:00Z'));
    const res = await s.ask(token);
    assert.ok(res.body.token, 'refreshed token returned');
    const p = verifyToken(res.body.token, SECRETS.SESSION_SIGNING_SECRET, { now: at('2026-09-22T10:00:00Z'), users: config.users, maxAgeSeconds: config.session.maxAgeSeconds });
    assert.equal(p.at, Math.floor(at('2026-09-20T10:00:00Z') / 1000), 'original login time kept');

    const late = issueToken({ user: 'alban', authTime: p.at, now: at('2026-10-19T10:00:00Z'), ttlSeconds: config.session.ttlSeconds, maxAgeSeconds: config.session.maxAgeSeconds }, SECRETS.SESSION_SIGNING_SECRET);
    assert.equal(late.expiresAt, (p.at + config.session.maxAgeSeconds) * 1000);
  });

  test('secretEquals', () => {
    assert.equal(secretEquals('abc', 'abc'), true);
    assert.equal(secretEquals('abc', 'abd'), false);
    assert.equal(secretEquals('', ''), false);
    assert.equal(secretEquals(undefined, 'abc'), false);
  });
});

describe('/ai request checks', () => {
  test('wrong method -> 405', async () => {
    const res = await setup().call({ path: '/ai', method: 'GET' });
    assert.equal(res.statusCode, 405);
  });

  test('wrong content type -> 415', async () => {
    const res = await setup().call({ path: '/ai', body: {}, headers: { 'content-type': 'text/plain' } });
    assert.equal(res.statusCode, 415);
  });

  test('foreign origin -> 403, preflight from own origin -> 204', async () => {
    const s = setup();
    assert.equal((await s.call({ path: '/ai', body: {}, headers: { origin: 'https://evil.example' } })).statusCode, 403);
    const pre = await s.call({ path: '/ai', method: 'OPTIONS' });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
  });

  test('unknown path -> 404', async () => {
    assert.equal((await setup().call({ path: '/admin', body: {} })).statusCode, 404);
  });

  test('bad payloads -> 400 / 413 and provider is never called', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    const bad = [
      {},
      { messages: [] },
      { messages: [{ role: 'system', text: 'x' }] },
      { messages: [{ role: 'model', text: 'x' }] },
      { messages: [{ role: 'user', text: 'hi' }], action: 'hack' },
      { messages: Array.from({ length: 20 }, () => ({ role: 'user', text: 'x' })) },
    ];
    for (const body of bad) assert.equal((await s.ask(token, body)).statusCode, 400, JSON.stringify(body).slice(0, 60));
    const long = await s.ask(token, { messages: [{ role: 'user', text: 'x'.repeat(1001) }] });
    assert.equal(long.statusCode, 413);
    assert.equal(s.provider.calls.length, 0);
  });

  test('oversized body -> 413', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    // The limit rose to 3 MB so a question can carry an inline photo.
    const res = await s.ask(token, { messages: [{ role: 'user', text: 'hi' }], pad: 'x'.repeat(config.limits.maxBodyBytes + 1000) });
    assert.equal(res.statusCode, 413);
  });

  test('per-user burst rate limit -> 429', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    for (let i = 0; i < config.rateLimits.aiPerUserBurst.limit; i++) assert.equal((await s.ask(token)).statusCode, 200);
    const res = await s.ask(token);
    assert.equal(res.statusCode, 429);
    assert.equal(s.provider.calls.length, config.rateLimits.aiPerUserBurst.limit);
    // the other traveller is not affected
    const other = (await s.login('alban')).body.token;
    assert.equal((await s.ask(other)).statusCode, 200);
  });
});

describe('photo attachment', () => {
  const PHOTO = { mimeType: 'image/jpeg', data: 'AAECAwQFBgcICQoL' };
  const withPhoto = (image) => ({ messages: [{ role: 'user', text: 'Was ist das?' }], image });

  test('a valid photo reaches the provider', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    const res = await s.ask(token, withPhoto(PHOTO));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(s.provider.calls[0].image, PHOTO);
  });

  test('no photo means no image field', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    await s.ask(token);
    assert.equal(s.provider.calls[0].image, undefined);
  });

  test('unsupported type and broken data are rejected', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    for (const bad of [
      { mimeType: 'image/heic', data: 'AAEC' },
      { mimeType: 'application/pdf', data: 'AAEC' },
      { mimeType: 'image/jpeg', data: 'nicht base64!!' },
      { mimeType: 'image/jpeg', data: 42 },
      'kein objekt',
    ]) {
      const res = await s.ask(token, withPhoto(bad));
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
    }
    assert.equal(s.provider.calls.length, 0, 'provider is never called for a bad photo');
  });

  test('an oversized photo is rejected with 413', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    const res = await s.ask(token, withPhoto({ mimeType: 'image/jpeg', data: 'A'.repeat(config.limits.maxImageBase64Chars + 4) }));
    assert.equal(res.statusCode, 413);
    assert.equal(res.body.error.code, 'image_too_large');
    assert.equal(s.provider.calls.length, 0);
  });
});

describe('AI answers and travel context', () => {
  test('Gemini request carries travel + today context (Kyoto)', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    const res = await s.ask(token);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reply, 'Antwort');
    const sys = s.provider.calls[0].system;
    assert.match(sys, /Alban & Deshira/);
    assert.match(sys, /Du sprichst gerade mit Deshira/);
    assert.match(sys, /Current destination: Kyoto/);
    assert.match(sys, /Date: 7\. Oktober 2026/);
    assert.match(sys, /Today's itinerary: Fushimi Inari/);
    assert.match(sys, /Next destination: Tokyo/);
    assert.match(sys, /Beijing → Shanghai → Hongkong → Osaka → Kyoto → Tokyo → Miyakojima/);
    assert.equal(s.provider.calls[0].maxOutputTokens, config.limits.maxOutputTokens);
  });

  test('date night and translation actions add a focus hint', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    await s.ask(token, { messages: [{ role: 'user', text: 'Plane uns ein romantisches Dinner.' }], action: 'date_night' });
    await s.ask(token, { messages: [{ role: 'user', text: 'Wie sage ich, dass wir eine Reservierung haben?' }], action: 'translate' });
    assert.match(s.provider.calls[0].system, /romantischer Abend/);
    assert.match(s.provider.calls[1].system, /Übersetzung in die Landessprache/);
  });

  test('chat history is passed through (trimmed + roles kept)', async () => {
    const s = setup();
    const { token } = (await s.login()).body;
    await s.ask(token, { messages: [
      { role: 'user', text: ' Hallo ' }, { role: 'model', text: 'Hi!' }, { role: 'user', text: 'Und morgen?' },
    ] });
    assert.deepEqual(s.provider.calls[0].messages, [
      { role: 'user', text: 'Hallo' }, { role: 'model', text: 'Hi!' }, { role: 'user', text: 'Und morgen?' },
    ]);
  });

  test('China / Hong Kong: region_unavailable, no provider call, availableFrom = 6 Oct', async () => {
    const s = setup({ now: BEIJING_DAY });
    const { token } = (await s.login()).body;
    const res = await s.ask(token);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, 'region_unavailable');
    assert.equal(res.body.error.availableFrom, '2026-10-06');
    assert.equal(s.provider.calls.length, 0);
  });

  test('fallback provider that supports CN would be used there', async () => {
    const gemini = fakeProvider(() => ({ text: 'gemini' }));
    const cn = { ...fakeProvider(() => ({ text: 'cn' }), ['CN', 'HK', 'JP', 'CH']), name: 'cn' };
    const handler = createHandler({
      config, getSecrets: () => SECRETS, providers: [gemini, cn], limiter: new MemoryRateLimiter(),
      loadTripData: async () => trip, now: () => BEIJING_DAY, log: silentLog,
    });
    const token = issueToken({ user: 'alban', now: BEIJING_DAY, ttlSeconds: 3600, maxAgeSeconds: 7200 }, SECRETS.SESSION_SIGNING_SECRET).token;
    const res = { status(c) { this.code = c; return this; }, set() { return this; }, json(b) { this.body = b; return this; } };
    await handler({ path: '/ai', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: { messages: [{ role: 'user', text: 'hi' }] } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.reply, 'cn');
    assert.equal(gemini.calls.length, 0);
  });

  for (const [kind, status, code] of [
    ['timeout', 504, 'ai_timeout'],
    ['unavailable', 503, 'ai_unavailable'],
    ['rate_limited', 429, 'ai_busy'],
    ['misconfigured', 500, 'ai_misconfigured'],
    ['rejected', 502, 'ai_rejected'],
  ]) {
    test(`provider error "${kind}" -> ${status} ${code}`, async () => {
      const s = setup({ provider: fakeProvider(() => { throw new ProviderError(kind, 'boom'); }) });
      const { token } = (await s.login()).body;
      const res = await s.ask(token);
      assert.equal(res.statusCode, status);
      assert.equal(res.body.error.code, code);
      assert.doesNotMatch(JSON.stringify(res.body), /boom/, 'internal details are not leaked');
    });
  }

  test('unexpected provider exception -> 503, no crash', async () => {
    const s = setup({ provider: fakeProvider(() => { throw new TypeError('kaputt'); }) });
    const { token } = (await s.login()).body;
    assert.equal((await s.ask(token)).statusCode, 503);
  });
});

describe('provider layer', () => {
  test('runWithFallback moves on only for retryable errors', async () => {
    const a = fakeProvider(() => { throw new ProviderError('timeout', 't', { retryable: true }); });
    const b = fakeProvider(() => ({ text: 'b' }));
    assert.equal((await runWithFallback([a, b], {})).text, 'b');

    const c = fakeProvider(() => { throw new ProviderError('misconfigured', 'm'); });
    const d = fakeProvider(() => ({ text: 'd' }));
    await assert.rejects(runWithFallback([c, d], {}), { kind: 'misconfigured' });
    assert.equal(d.calls.length, 0);
  });

  test('gemini adapter sends a stateless Interactions request', async () => {
    let sent;
    const client = { interactions: { create: async (params, opts) => { sent = { params, opts }; return { status: 'completed', output_text: ' Hallo! ' }; } } };
    const p = createGeminiProvider({ model: 'gemini-test', client });
    const out = await p.generate({ system: 'SYS', messages: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' }], maxOutputTokens: 100, timeoutMs: 5000 });
    assert.equal(out.text, 'Hallo!');
    assert.equal(sent.params.model, 'gemini-test');
    assert.equal(sent.params.store, false);
    assert.equal(sent.params.system_instruction, 'SYS');
    assert.deepEqual(sent.params.input.map((i) => i.type), ['user_input', 'model_output', 'user_input']);
    assert.equal(sent.params.generation_config.max_output_tokens, 100);
    assert.equal(sent.opts.timeout_ms, 5000);
    assert.deepEqual(sent.opts.retries, { strategy: 'none' });
    assert.deepEqual(p.supportedCountries.includes('CN') || p.supportedCountries.includes('HK'), false);
  });

  test('gemini adapter without key is misconfigured; empty answer is unavailable', async () => {
    await assert.rejects(createGeminiProvider({ model: 'm' }).generate({ messages: [] }), { kind: 'misconfigured' });
    const client = { interactions: { create: async () => ({ status: 'failed', steps: [] }) } };
    await assert.rejects(createGeminiProvider({ model: 'm', client }).generate({ messages: [{ role: 'user', text: 'x' }] }), { kind: 'unavailable' });
  });

  test('gemini error mapping (Gemini unreachable etc.)', () => {
    const e = (name, status, message = '') => Object.assign(new Error(message), { name, status });
    assert.equal(mapError(e('RequestTimeoutError')).kind, 'timeout');
    assert.equal(mapError(e('ConnectionError')).kind, 'unavailable');
    assert.equal(mapError(new TypeError('fetch failed')).kind, 'unavailable');
    assert.equal(mapError(e('APIError', 429)).kind, 'rate_limited');
    assert.equal(mapError(e('APIError', 403)).kind, 'misconfigured');
    assert.equal(mapError(e('APIError', 400, 'User location is not supported for the API use.')).kind, 'unavailable');
    assert.equal(mapError(e('APIError', 503)).kind, 'unavailable');
    assert.equal(mapError(e('APIError', 400, 'bad')).kind, 'rejected');
  });
});

describe('diary', () => {
  const day = { date: '2026-09-22', text: 'Erster Tag in Rom.', mood: 'gluecklich', expenses: [{ label: 'Gelato', amount: 4.5, currency: 'EUR' }] };
  const photo = (extra = {}) => ({ date: '2026-09-22', image: { mimeType: 'image/jpeg', data: 'AAECAwQFBgcICQoL' }, ...extra });
  const auth = (token) => ({ authorization: 'Bearer ' + token });
  const tokenFor = async (s, user) => (await s.login(user)).body.token;

  test('a day is saved and comes back in the list', async () => {
    const s = setup();
    const token = await tokenFor(s, 'alban');
    const saved = await s.call({ path: '/diary/save', body: day, headers: auth(token) });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.day.text, day.text);
    assert.equal(saved.body.day.mood, 'gluecklich');
    assert.deepEqual(saved.body.day.expenses, day.expenses);

    const list = await s.call({ path: '/diary/list', body: {}, headers: auth(token) });
    assert.equal(list.body.days.length, 1);
    assert.equal(list.body.days[0].date, '2026-09-22');
    assert.equal(list.body.days[0].user, undefined, 'the owner is never echoed back');
  });

  test('each diary only ever shows its own days', async () => {
    const s = setup();
    const alban = await tokenFor(s, 'alban');
    const deshira = await tokenFor(s, 'deshira');
    await s.call({ path: '/diary/save', body: day, headers: auth(alban) });
    await s.call({ path: '/diary/save', body: { ...day, text: 'Ihr Eintrag.' }, headers: auth(deshira) });

    const hers = await s.call({ path: '/diary/list', body: {}, headers: auth(deshira) });
    assert.equal(hers.body.days.length, 1);
    assert.equal(hers.body.days[0].text, 'Ihr Eintrag.');
  });

  test('photos: add, read back, remove', async () => {
    const s = setup();
    const token = await tokenFor(s, 'alban');
    const added = await s.call({ path: '/diary/photo/add', body: photo({ caption: 'Kolosseum' }), headers: auth(token) });
    assert.equal(added.statusCode, 200);
    const { id } = added.body.photo;
    assert.equal(added.body.photo.caption, 'Kolosseum');
    assert.equal(s.bucket.files.size, 1);

    const got = await s.call({ path: '/diary/photo/get', body: { date: '2026-09-22', id }, headers: auth(token) });
    assert.equal(got.body.photo.data, 'AAECAwQFBgcICQoL');

    const gone = await s.call({ path: '/diary/photo/remove', body: { date: '2026-09-22', id }, headers: auth(token) });
    assert.equal(gone.statusCode, 200);
    assert.equal(s.bucket.files.size, 0);
    assert.equal((await s.call({ path: '/diary/photo/get', body: { date: '2026-09-22', id }, headers: auth(token) })).statusCode, 404);
  });

  test('a photo from the other diary is not readable', async () => {
    const s = setup();
    const alban = await tokenFor(s, 'alban');
    const deshira = await tokenFor(s, 'deshira');
    const { id } = (await s.call({ path: '/diary/photo/add', body: photo(), headers: auth(alban) })).body.photo;
    assert.equal((await s.call({ path: '/diary/photo/get', body: { date: '2026-09-22', id }, headers: auth(deshira) })).statusCode, 404);
  });

  test('without a session nothing works', async () => {
    const s = setup();
    for (const path of ['/diary/list', '/diary/save', '/diary/photo/add', '/diary/photo/get', '/diary/photo/remove']) {
      assert.equal((await s.call({ path, body: {} })).statusCode, 401, path);
    }
  });

  test('bad input is rejected', async () => {
    const s = setup();
    const token = await tokenFor(s, 'alban');
    const send = (path, body) => s.call({ path, body, headers: auth(token) });
    assert.equal((await send('/diary/save', { date: '22.09.2026' })).statusCode, 400);
    assert.equal((await send('/diary/save', { date: '2026-09-22', text: 'x'.repeat(config.limits.maxDiaryTextChars + 1) })).statusCode, 413);
    assert.equal((await send('/diary/save', { date: '2026-09-22', expenses: [{ label: 'x', amount: 'viel' }] })).statusCode, 400);
    assert.equal((await send('/diary/photo/add', { date: '2026-09-22', image: { mimeType: 'image/gif', data: 'AAEC' } })).statusCode, 400);
    assert.equal((await send('/diary/photo/get', { date: '2026-09-22', id: '../../etc/passwd' })).statusCode, 400);
  });

  test('the per-day photo limit holds', async () => {
    const s = setup();
    const token = await tokenFor(s, 'alban');
    for (let i = 0; i < config.limits.maxDiaryPhotosPerDay; i += 1) {
      assert.equal((await s.call({ path: '/diary/photo/add', body: photo(), headers: auth(token) })).statusCode, 200);
    }
    const tooMany = await s.call({ path: '/diary/photo/add', body: photo(), headers: auth(token) });
    assert.equal(tooMany.statusCode, 409);
    assert.equal(tooMany.body.error.code, 'too_many_photos');
  });
});

describe('trip logic', () => {
  test('before / during / after', () => {
    const before = getTripStatus(trip, new Date(at('2026-09-17T10:00:00Z')));
    assert.equal(before.phase, 'before');
    assert.equal(before.daysUntilStart, 4);
    assert.equal(getTripStatus(trip, new Date(at('2026-10-20T10:00:00Z'))).phase, 'after');
    const kyoto = getTripStatus(trip, new Date(KYOTO_DAY));
    assert.deepEqual(kyoto.current.map((s) => s.id), ['kyoto']);
    assert.equal(kyoto.next.id, 'tokyo');
  });

  test('Rome is the first stop and the AI is available there', () => {
    const rome = getTripStatus(trip, new Date(at('2026-09-22T10:00:00Z')));
    assert.deepEqual(rome.current.map((s) => s.id), ['rom']);
    assert.equal(rome.next.id, 'beijing');
    assert.equal(getAiRegionStatus(trip, new Date(at('2026-09-22T10:00:00Z')), ['CH', 'IT', 'JP']).blocked, false);
    // Departure day is still Rome; Beijing (and the AI block) starts on 25 Sep.
    assert.deepEqual(getTripStatus(trip, new Date(at('2026-09-24T10:00:00Z'))).current.map((s) => s.id), ['rom']);
    assert.equal(getAiRegionStatus(trip, new Date(at('2026-09-25T10:00:00Z')), ['CH', 'IT', 'JP']).blocked, true);
  });

  test('travel day HK -> Osaka is blocked (fail closed), 6 Oct is open', () => {
    const t = getTripStatus(trip, new Date(at('2026-10-05T05:00:00Z')));
    assert.deepEqual(t.current.map((s) => s.id), ['hongkong', 'osaka']);
    assert.equal(getAiRegionStatus(trip, new Date(at('2026-10-05T05:00:00Z')), ['CH', 'JP']).blocked, true);
    assert.equal(getAiRegionStatus(trip, new Date(at('2026-10-06T01:00:00Z')), ['CH', 'JP']).blocked, false);
    assert.equal(getAiRegionStatus(trip, new Date(at('2026-09-17T10:00:00Z')), ['CH', 'JP']).blocked, false);
  });

  test('range days (Miyakojima) show up as today', () => {
    const ctx = buildTravelContext(trip, new Date(at('2026-10-12T03:00:00Z')));
    assert.match(ctx, /Current destination: Miyakojima/);
    assert.match(ctx, /Today's itinerary: Ausschlafen/);
  });

  test('system prompt includes emergency numbers from trip data', () => {
    const sys = buildSystemPrompt(trip, KYOTO_DAY, 'alban', 'chat');
    assert.match(sys, /999/);
    assert.match(sys, /Du sprichst gerade mit Alban/);
  });

  test('trip data loader falls back to bundled copy', async () => {
    const load = createTripDataLoader({ url: 'https://example.invalid/x.json', bundled: trip, fetchImpl: async () => { throw new Error('offline'); } });
    const orig = console.warn; console.warn = () => {};
    try { assert.equal(await load(), trip); } finally { console.warn = orig; }
    const live = { ...trip, title: 'live' };
    const load2 = createTripDataLoader({ url: 'x', bundled: trip, fetchImpl: async () => ({ ok: true, json: async () => live }) });
    assert.equal((await load2()).title, 'live');
    const load3 = createTripDataLoader({ url: 'x', bundled: trip, fetchImpl: async () => ({ ok: true, json: async () => ({ evil: true }) }) });
    const o = console.warn; console.warn = () => {};
    try { assert.equal(await load3(), trip); } finally { console.warn = o; }
  });

  test('validateAiRequest defaults action to chat', () => {
    const v = validateAiRequest({ messages: [{ role: 'user', text: 'x' }] }, config.limits);
    assert.equal(v.value.action, 'chat');
  });
});
