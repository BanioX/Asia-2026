// ✨ Asia AI Concierge – frontend.
// Talks only to our own backend (/session, /ai). No AI request is made unless
// Alban or Deshira actively asks something. Chat history stays on this device (IndexedDB).
import { AI_API_BASE, AI_CLIENT_TIMEOUT_MS, AI_LOGIN_TIMEOUT_MS, AI_HISTORY_MESSAGES, AI_SUPPORTED_COUNTRIES, appNow } from './app-config.js';
import { getAiRegionStatus, formatLongDate } from './trip-core.js';
import { h, richText, clear } from './dom.js';

const SESSION_KEY = 'asiaAiSession';
const USERS = [{ id: 'alban', name: 'Alban' }, { id: 'deshira', name: 'Deshira' }];
const QUICK_ACTIONS = [
  { action: 'today', label: '📅 Heute', prompt: 'Was machen wir heute?' },
  { action: 'tomorrow', label: '🧳 Morgen', prompt: 'Was müssen wir morgen beachten?' },
  { action: 'date_night', label: '❤️ Date Night', prompt: 'Plane uns ein romantisches Dinner für heute Abend.' },
  { action: 'rain', label: '🌧️ Regenplan', prompt: 'Was können wir bei Regen machen?' },
  { action: 'food', label: '🍜 Essen', prompt: 'Was sollten wir hier unbedingt essen?' },
  { action: 'translate', label: '🈯 Übersetzen', prefill: 'Übersetze: ' },
];

// ---------- photo attachment ----------
// One photo may ride along with a question. It is downscaled in the browser first:
// phone pictures are several MB, the backend accepts ~1 MB of base64.
let pendingImage = null;
const retryImages = new Map(); // messageId -> image, so a failed send can be retried with its photo

function compressImage(file, maxSide = 1152, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const hgt = Math.max(1, Math.round(img.height * scale));
      const canvas = Object.assign(document.createElement('canvas'), { width: w, height: hgt });
      canvas.getContext('2d').drawImage(img, 0, 0, w, hgt);
      const full = canvas.toDataURL('image/jpeg', quality);
      const ts = Math.min(1, 320 / Math.max(w, hgt));
      const small = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w * ts)), height: Math.max(1, Math.round(hgt * ts)) });
      small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
      resolve({ mimeType: 'image/jpeg', data: full.split(',')[1], thumb: small.toDataURL('image/jpeg', 0.6) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    img.src = url;
  });
}

// ---------- session (signed token issued by the backend) ----------
let memorySession = null;

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.token && s.expiresAt > Date.now() ? s : null;
  } catch { return null; }
}
export function openAiPanel() {
  document.getElementById('aiOpen')?.click();
}

function announce() {
  window.dispatchEvent(new CustomEvent('asia:session'));
}

function saveSession(s) {
  memorySession = s;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode: session lasts until reload */ }
  announce();
}
function dropSession() {
  memorySession = null;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  announce();
}
export function currentSession() {
  return loadSession() || (memorySession && memorySession.expiresAt > Date.now() ? memorySession : null);
}

// ---------- chat store (IndexedDB, in-memory fallback) ----------
const store = (() => {
  let dbPromise = null;
  let memory = [];
  let nextId = 1;
  const open = () => {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    dbPromise ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open('asia2026-ai', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  };
  const tx = async (mode, idbFn, memFn) => {
    const db = await open();
    if (!db) return memFn();
    return new Promise((resolve, reject) => {
      const t = db.transaction('messages', mode);
      const req = idbFn(t.objectStore('messages'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    all: () => tx('readonly', (os) => os.getAll(), () => memory.map((m) => ({ ...m }))),
    add: (msg) => tx('readwrite', (os) => os.add(msg), () => { memory.push({ ...msg, id: nextId }); return nextId++; }),
    put: (msg) => tx('readwrite', (os) => os.put(msg), () => { memory = memory.map((m) => (m.id === msg.id ? { ...msg } : m)); }),
    clear: () => tx('readwrite', (os) => os.clear(), () => { memory = []; }),
  };
})();

// ---------- API ----------
export async function apiPost(path, body, { token, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${AI_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  } catch (err) {
    return { status: 0, data: null, timeout: err?.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- UI ----------
export function initAi(trip) {
  const panel = document.getElementById('aiPanel');
  const body = document.getElementById('aiBody');
  const openBtn = document.getElementById('aiOpen');
  const closeBtn = document.getElementById('aiClose');
  let busy = false;
  let view = null;
  let els = null;

  function open() {
    panel.hidden = false;
    document.body.classList.add('ai-open');
    render();
  }
  function close() {
    panel.hidden = true;
    document.body.classList.remove('ai-open');
  }
  openBtn.addEventListener('click', (e) => { e.preventDefault(); open(); });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  const regionStatus = () => getAiRegionStatus(trip, appNow(), AI_SUPPORTED_COUNTRIES);

  function render(opts = {}) {
    els = null;
    const region = regionStatus();
    if (region.blocked) return renderUnavailable({ region: true, availableFrom: region.availableFrom });
    if (!currentSession()) return renderGate(opts.gateMessage);
    return renderChat();
  }

  // --- unavailable (region / offline / backend down) ---
  function unavailableCard({ region, availableFrom, detail, onRetry }) {
    return h('div', { class: 'ai-unavailable', role: 'status' },
      h('div', { class: 'ai-unavailable-title' }, '✨ AI Concierge momentan nicht verfügbar'),
      h('p', {}, 'Dein Reiseplan ist weiterhin vollständig verfügbar.'),
      h('p', { class: 'muted' }, 'Dein Reiseguide funktioniert weiterhin offline.'),
      region
        ? h('p', { class: 'muted' }, `In China und Hongkong ist Gemini offiziell nicht verfügbar.${availableFrom ? ` Ab ${formatLongDate(availableFrom)} (Japan) geht es wieder.` : ''}`)
        : null,
      detail ? h('p', { class: 'muted' }, detail) : null,
      h('div', { class: 'ai-row' },
        h('button', { type: 'button', class: 'ai-retry', onclick: onRetry || (() => render()) }, 'Erneut versuchen'),
        h('a', { class: 'ai-link', href: '#home', onclick: () => close() }, 'Zum Reiseplan')));
  }

  function renderUnavailable(opts) {
    view = 'unavailable';
    els = null;
    clear(body).append(h('div', { class: 'ai-center' }, unavailableCard(opts)));
  }

  // --- gate ---
  function renderGate(message) {
    view = 'gate';
    let selected = USERS[1].id;
    const err = h('div', { class: 'ai-error', role: 'alert' }, message || '');
    const username = h('input', { type: 'text', name: 'username', autocomplete: 'username', value: selected, hidden: true });
    const code = h('input', { type: 'password', id: 'aiCode', name: 'password', autocomplete: 'current-password', placeholder: 'Zugangscode', maxlength: '200' });
    const btn = h('button', { type: 'submit', class: 'ai-primary' }, 'Entsperren');
    const choices = USERS.map((u) => h('button', {
      type: 'button', class: 'ai-choice', 'aria-pressed': String(u.id === selected), 'data-user': u.id,
      onclick: () => {
        selected = u.id;
        username.value = u.id;
        choices.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.user === selected)));
      },
    }, u.name));

    const form = h('form', { class: 'ai-gate' },
      h('div', { class: 'ai-heart' }, '❤️'),
      h('div', { class: 'ai-gate-title' }, 'Alban & Deshira'),
      h('div', { class: 'ai-gate-sub' }, 'Asia 2026'),
      h('div', { class: 'ai-gate-kicker' }, 'Private Travel Concierge'),
      h('div', { class: 'ai-choices', role: 'group', 'aria-label': 'Wer bist du?' }, choices),
      username, code, btn, err);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      if (!code.value) { err.textContent = 'Bitte Zugangscode eingeben.'; return; }
      if (!navigator.onLine) { err.textContent = 'Keine Internetverbindung – bitte später erneut versuchen.'; return; }
      busy = true;
      btn.disabled = true;
      btn.textContent = 'Prüfe …';
      err.textContent = '';
      const r = await apiPost('/session', { user: selected, code: code.value }, { timeoutMs: AI_LOGIN_TIMEOUT_MS });
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Entsperren';
      if (r.status === 200 && r.data?.token) {
        code.value = '';
        saveSession({ token: r.data.token, user: r.data.user, expiresAt: r.data.expiresAt });
        render();
      } else if (r.status === 0) {
        err.textContent = r.timeout
          ? 'Der Concierge antwortet nicht – bitte später erneut versuchen.'
          : 'Keine Verbindung zum Concierge – bitte später erneut versuchen.';
      } else {
        err.textContent = r.data?.error?.message || 'Entsperren fehlgeschlagen.';
        if (r.status === 401) { code.value = ''; code.focus(); }
      }
    });

    clear(body).append(h('div', { class: 'ai-center' }, form));
  }

  // --- chat ---
  async function renderChat() {
    view = 'chat';
    const session = currentSession();
    const who = USERS.find((u) => u.id === session.user)?.name || session.user;
    const list = h('div', { class: 'ai-messages', 'aria-live': 'polite' });
    const status = h('div', { class: 'ai-status' });
    const input = h('textarea', { id: 'aiInput', rows: '1', maxlength: '1000', placeholder: 'Frag den Concierge …', 'aria-label': 'Deine Frage' });
    const send = h('button', { type: 'submit', class: 'ai-send', 'aria-label': 'Senden' }, '➤');
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true' });
    const clip = h('button', { type: 'button', class: 'ai-clip', 'aria-label': 'Foto anhängen' }, '📎');
    const attach = h('div', { class: 'ai-attach', hidden: true });
    clip.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      try {
        pendingImage = await compressImage(file);
      } catch {
        if (els) els.status.textContent = 'Das Foto konnte nicht gelesen werden.';
        return;
      }
      showAttachment();
    });
    const form = h('form', { class: 'ai-input' }, clip, fileInput, input, send);
    const quick = h('div', { class: 'ai-quick' }, QUICK_ACTIONS.map((q) => h('button', {
      type: 'button', class: 'chip',
      onclick: () => {
        if (q.prefill) { input.value = q.prefill; input.focus(); return; }
        ask(q.prompt, q.action);
      },
    }, q.label)));

    let confirming = false;
    const clearBtn = h('button', { type: 'button', class: 'ai-link danger', id: 'aiClear' }, 'AI Chatverlauf löschen');
    clearBtn.addEventListener('click', async () => {
      if (!confirming) {
        confirming = true;
        clearBtn.textContent = 'Wirklich löschen? Nochmal tippen';
        setTimeout(() => { confirming = false; clearBtn.textContent = 'AI Chatverlauf löschen'; }, 4000);
        return;
      }
      confirming = false;
      await store.clear();
      clearBtn.textContent = 'AI Chatverlauf löschen';
      clear(status);
      await drawMessages();
    });
    const logout = h('button', { type: 'button', class: 'ai-link', onclick: () => { dropSession(); render(); } }, 'Abmelden');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ask(input.value, 'chat');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value, 'chat'); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });

    els = { list, status, input, send, attach };
    clear(body).append(
      h('div', { class: 'ai-bar' }, h('span', {}, `Hallo ${who} ✨`), h('span', { class: 'ai-bar-actions' }, clearBtn, logout)),
      list, status, quick, attach, form);
    await drawMessages();
  }

  async function drawMessages() {
    if (!els) return;
    const msgs = await store.all();
    clear(els.list);
    if (!msgs.length) {
      els.list.append(h('div', { class: 'ai-empty' },
        h('p', {}, 'Frag mich alles zu eurer Reise – ich kenne euren Plan und weiß, wo ihr heute seid.'),
        h('p', { class: 'muted' }, 'Zum Beispiel: „Was machen wir heute Abend?“')));
    }
    for (const m of msgs) {
      els.list.append(h('div', { class: `ai-msg ${m.role}${m.status === 'failed' ? ' failed' : ''}` },
        m.thumb ? h('img', { class: 'ai-img', src: m.thumb, alt: 'Angehängtes Foto' }) : null,
        m.role === 'model' ? richText(m.text) : h('div', {}, m.text),
        m.status === 'failed' ? h('small', {}, 'nicht gesendet') : null));
    }
    els.list.scrollTop = els.list.scrollHeight;
  }

  function showAttachment() {
    if (!els?.attach) return;
    const box = clear(els.attach);
    box.hidden = !pendingImage;
    if (!pendingImage) return;
    const remove = h('button', { type: 'button', 'aria-label': 'Foto entfernen' }, '✕');
    remove.addEventListener('click', () => { pendingImage = null; showAttachment(); });
    box.append(h('img', { src: pendingImage.thumb, alt: '' }), h('span', { class: 'muted' }, 'Foto angehängt'), remove);
  }

  function setBusy(on) {
    busy = on;
    if (!els) return;
    els.send.disabled = on;
    clear(els.status);
    if (on) els.status.append(h('div', { class: 'ai-typing', 'aria-label': 'Concierge schreibt' }, h('i'), h('i'), h('i')));
  }

  async function ask(rawText, action) {
    const image = pendingImage;
    // A photo on its own is a valid question – give it a default one.
    const text = String(rawText || '').trim() || (image ? 'Was ist auf diesem Foto? Erkläre es kurz – im Zusammenhang mit unserer Reise.' : '');
    if (busy || !text || !els) return;
    if (text.length > 1000) { els.status.textContent = 'Die Frage ist zu lang (max. 1000 Zeichen).'; return; }
    els.input.value = '';
    els.input.style.height = 'auto';
    pendingImage = null;
    showAttachment();
    const id = await store.add({ role: 'user', text, ts: Date.now(), status: 'pending', thumb: image?.thumb || null });
    if (image) retryImages.set(id, image);
    await drawMessages();
    await submit(id, action);
  }

  async function submit(messageId, action) {
    const all = await store.all();
    const msg = all.find((m) => m.id === messageId);
    if (!msg) return;
    const region = regionStatus();
    if (region.blocked) return fail(msg, () => renderUnavailable({ region: true, availableFrom: region.availableFrom }));
    if (!navigator.onLine) return fail(msg, () => showUnavailable(messageId, action, 'Keine Internetverbindung.'));
    const session = currentSession();
    if (!session) return fail(msg, () => render({ gateMessage: 'Bitte erneut entsperren.' }));

    const history = all
      .filter((m) => m.id !== messageId && m.status !== 'failed' && m.status !== 'pending')
      .slice(-AI_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
    while (history.length && history[0].role !== 'user') history.shift();

    setBusy(true);
    const image = retryImages.get(messageId);
    const payload = { messages: [...history, { role: 'user', text: msg.text }], action };
    if (image) payload.image = { mimeType: image.mimeType, data: image.data };
    const r = await apiPost('/ai', payload, { token: session.token, timeoutMs: AI_CLIENT_TIMEOUT_MS });
    setBusy(false);

    if (r.status === 200 && typeof r.data?.reply === 'string') {
      if (r.data.token) saveSession({ ...session, token: r.data.token, expiresAt: r.data.expiresAt });
      retryImages.delete(messageId);
      await store.put({ ...msg, status: 'ok' });
      await store.add({ role: 'model', text: r.data.reply, ts: Date.now() });
      await drawMessages();
      return;
    }

    const code = r.data?.error?.code;
    if (r.status === 401) {
      dropSession();
      return fail(msg, () => render({ gateMessage: 'Sitzung abgelaufen – bitte erneut entsperren.' }));
    }
    if (code === 'region_unavailable') {
      return fail(msg, () => renderUnavailable({ region: true, availableFrom: r.data.error.availableFrom }));
    }
    if ([400, 413, 429].includes(r.status) || code === 'ai_rejected') {
      return fail(msg, () => { if (els) els.status.textContent = r.data?.error?.message || 'Anfrage nicht möglich.'; });
    }
    const detail = r.status === 0
      ? (r.timeout ? `Keine Antwort innerhalb von ${AI_CLIENT_TIMEOUT_MS / 1000} Sekunden.` : 'Keine Verbindung zum Concierge.')
      : r.data?.error?.message;
    return fail(msg, () => showUnavailable(messageId, action, detail));
  }

  async function fail(msg, then) {
    await store.put({ ...msg, status: 'failed' });
    await drawMessages();
    then?.();
  }

  function showUnavailable(messageId, action, detail) {
    if (!els) return;
    clear(els.status).append(unavailableCard({
      detail,
      onRetry: async () => {
        const all = await store.all();
        const msg = all.find((m) => m.id === messageId);
        if (!msg || busy) return;
        await store.put({ ...msg, status: 'pending' });
        await drawMessages();
        await submit(messageId, action);
      },
    }));
  }
}
