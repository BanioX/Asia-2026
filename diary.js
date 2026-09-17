// Travel diary. Everything is written locally first and synced when there is a
// connection - on this trip that is the normal case, not the exception.
// Alban and Deshira each get their own diary; the session token decides which one.
import { h, clear, richText } from './dom.js';
import { formatLongDate } from './trip-core.js';
import { appNow, AI_CLIENT_TIMEOUT_MS } from './app-config.js';
import { apiPost, currentSession, openAiPanel } from './ai.js';

const MOODS = ['😍', '😊', '😌', '🤩', '😴', '🥵', '🌧️', '🤯'];
const MAX_TEXT = 4000;
const SAVE_DEBOUNCE_MS = 1200;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- local storage (IndexedDB, in-memory fallback) ----------
const db = (() => {
  const mem = { days: new Map(), queue: new Map(), photos: new Map() };
  let handle = null;
  const open = () => handle ??= new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('asiaDiary', 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('days')) d.createObjectStore('days', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });

  const run = async (store, mode, fn, memFn) => {
    const d = await open();
    if (!d) return memFn(mem[store]);
    return new Promise((resolve) => {
      const tx = d.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => resolve(memFn(mem[store]));
    });
  };

  return {
    allDays: () => run('days', 'readonly', (s) => s.getAll(), (m) => [...m.values()]),
    putDay: (day) => run('days', 'readwrite', (s) => s.put(day), (m) => m.set(day.date, day)),
    replaceDays: (days) => run('days', 'readwrite', (s) => { s.clear(); days.forEach((d) => s.put(d)); }, (m) => {
      m.clear();
      days.forEach((d) => m.set(d.date, d));
    }),
    queued: () => run('queue', 'readonly', (s) => s.getAll(), (m) => [...m.values()]),
    enqueue: (op) => run('queue', 'readwrite', (s) => s.add(op), (m) => m.set(m.size + 1, { ...op, id: m.size + 1 })),
    dequeue: (id) => run('queue', 'readwrite', (s) => s.delete(id), (m) => m.delete(id)),
    getPhoto: (id) => run('photos', 'readonly', (s) => s.get(id), (m) => m.get(id)),
    putPhoto: (p) => run('photos', 'readwrite', (s) => s.put(p), (m) => m.set(p.id, p)),
    dropPhoto: (id) => run('photos', 'readwrite', (s) => s.delete(id), (m) => m.delete(id)),
  };
})();

// ---------- photo downscaling ----------
// A phone photo is several MB; the backend takes about 1 MB. 1600px is plenty for
// looking back on a trip and keeps uploads usable on hotel wifi.
export function shrinkPhoto(file, maxSide = 1600, quality = 0.74) {
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
      const thumbScale = Math.min(1, 400 / Math.max(w, hgt));
      const thumb = Object.assign(document.createElement('canvas'), {
        width: Math.max(1, Math.round(w * thumbScale)),
        height: Math.max(1, Math.round(hgt * thumbScale)),
      });
      thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
      resolve({
        mimeType: 'image/jpeg',
        data: canvas.toDataURL('image/jpeg', quality).split(',')[1],
        thumb: thumb.toDataURL('image/jpeg', 0.62),
      });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    img.src = url;
  });
}

/** The currency of wherever the itinerary says we are on that date. */
function currencyForDate(trip, date) {
  const byCountry = { CH: 'CHF', IT: 'EUR', CN: 'CNY', HK: 'HKD', JP: 'JPY' };
  const stop = trip.stops.find((s) => s.from <= date && date <= s.to);
  return byCountry[stop?.country] || null;
}

export function initDiary(trip) {
  const root = document.getElementById('diary');
  if (!root) return;

  let days = new Map(); // date -> day
  let date = iso(appNow());
  let saveTimer = null;
  let status = '';
  let syncing = false;

  const dayOf = (d) => days.get(d) || { date: d, text: '', mood: '', expenses: [], photos: [] };

  function setStatus(text) {
    status = text;
    const el = root.querySelector('.diary-status');
    if (el) el.textContent = text;
  }

  // ---------- sync ----------
  async function flushQueue(session) {
    for (const op of (await db.queued()) ?? []) {
      const r = await apiPost(op.path, op.body, { token: session.token, timeoutMs: AI_CLIENT_TIMEOUT_MS });
      if (r.status === 200) {
        await db.dequeue(op.id);
        continue;
      }
      // 4xx (except 429) will never succeed – drop it instead of blocking the queue forever.
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        await db.dequeue(op.id);
        continue;
      }
      return false; // offline or server trouble: try again later
    }
    return true;
  }

  async function sync({ silent = false } = {}) {
    const session = currentSession();
    if (!session || !navigator.onLine || syncing) return;
    syncing = true;
    if (!silent) setStatus('Synchronisiere …');
    try {
      if (!await flushQueue(session)) {
        setStatus('Noch nicht hochgeladen – wird bei Internet nachgeholt.');
        return;
      }
      const r = await apiPost('/diary/list', {}, { token: session.token, timeoutMs: AI_CLIENT_TIMEOUT_MS });
      if (r.status === 200 && Array.isArray(r.data?.days)) {
        const fresh = r.data.days.map((d) => ({ ...d, expenses: d.expenses ?? [], photos: d.photos ?? [] }));
        // Keep photos taken on this device that the server has not confirmed yet.
        for (const d of fresh) {
          const local = days.get(d.date);
          if (local?.pendingPhotos?.length) d.pendingPhotos = local.pendingPhotos;
        }
        await db.replaceDays(fresh);
        days = new Map(fresh.map((d) => [d.date, d]));
        setStatus('');
        render();
        return;
      }
      setStatus(r.status === 401 ? 'Sitzung abgelaufen – bitte erneut entsperren.' : '');
    } finally {
      syncing = false;
    }
  }

  /** Save locally first, then queue for the server. The UI never waits for the network. */
  async function persist(day) {
    days.set(day.date, day);
    await db.putDay(day);
    await db.enqueue({
      path: '/diary/save',
      body: { date: day.date, text: day.text, mood: day.mood, expenses: day.expenses },
    });
    sync({ silent: true });
  }

  function queueSave(day) {
    clearTimeout(saveTimer);
    setStatus('Gespeichert auf dem Gerät …');
    saveTimer = setTimeout(() => persist(day), SAVE_DEBOUNCE_MS);
  }

  // ---------- actions ----------
  async function addPhotos(files) {
    const day = dayOf(date);
    for (const file of files) {
      let shrunk;
      try {
        shrunk = await shrinkPhoto(file);
      } catch {
        setStatus('Ein Foto konnte nicht gelesen werden.');
        continue;
      }
      const tmpId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      day.pendingPhotos = [...(day.pendingPhotos ?? []), { tmpId, thumb: shrunk.thumb }];
      await db.putPhoto({ id: tmpId, thumb: shrunk.thumb });
      await db.enqueue({
        path: '/diary/photo/add',
        body: { date: day.date, image: { mimeType: shrunk.mimeType, data: shrunk.data } },
      });
    }
    days.set(day.date, day);
    await db.putDay(day);
    render();
    sync({ silent: true });
  }

  async function removePhoto(photo) {
    const day = dayOf(date);
    day.photos = (day.photos ?? []).filter((p) => p.id !== photo.id);
    days.set(day.date, day);
    await db.putDay(day);
    await db.dropPhoto(photo.id);
    await db.enqueue({ path: '/diary/photo/remove', body: { date: day.date, id: photo.id } });
    render();
    sync({ silent: true });
  }

  /** Photos from the other phone are fetched once and then kept on this one. */
  async function photoSrc(photo, imgEl) {
    const cached = await db.getPhoto(photo.id);
    if (cached?.thumb) {
      imgEl.src = cached.thumb;
      return;
    }
    const session = currentSession();
    if (!session || !navigator.onLine) return;
    const r = await apiPost('/diary/photo/get', { date, id: photo.id }, { token: session.token, timeoutMs: AI_CLIENT_TIMEOUT_MS });
    if (r.status !== 200 || !r.data?.photo) return;
    const src = `data:${r.data.photo.mimeType};base64,${r.data.photo.data}`;
    imgEl.src = src;
    await db.putPhoto({ id: photo.id, thumb: src });
  }

  async function aiDraft() {
    const session = currentSession();
    if (!session) return setStatus('Zum Schreiben-Lassen bitte entsperren.');
    if (!navigator.onLine) return setStatus('Der Entwurf braucht Internet.');
    const day = dayOf(date);
    const photoCount = (day.photos?.length ?? 0) + (day.pendingPhotos?.length ?? 0);
    const spent = (day.expenses ?? []).map((e) => `${e.amount} ${e.currency} ${e.label}`).join(', ');
    const notes = [
      day.text ? `Meine Stichworte: ${day.text}` : 'Ich habe noch nichts aufgeschrieben.',
      day.mood ? `Stimmung: ${day.mood}` : '',
      photoCount ? `Ich habe heute ${photoCount} Fotos gemacht.` : '',
      spent ? `Ausgaben: ${spent}` : '',
    ].filter(Boolean).join(' ');

    setStatus('Der Concierge schreibt …');
    const r = await apiPost('/ai', {
      action: 'diary',
      messages: [{
        role: 'user',
        text: `Schreib mir aus diesen Angaben einen Tagebucheintrag für den ${formatLongDate(date)}. Persönlich, in der Ich-Form, 4-6 Sätze, ohne Überschrift. ${notes}`,
      }],
    }, { token: session.token, timeoutMs: 25000 });

    if (r.status === 200 && typeof r.data?.reply === 'string') {
      setStatus('');
      showDraft(r.data.reply);
      return;
    }
    setStatus(r.data?.error?.message || 'Der Entwurf hat nicht geklappt.');
  }

  function showDraft(text) {
    const box = root.querySelector('.diary-draft');
    if (!box) return;
    clear(box).hidden = false;
    const take = h('button', { type: 'button', class: 'diary-btn' }, 'Übernehmen');
    const drop = h('button', { type: 'button', class: 'diary-btn ghost' }, 'Verwerfen');
    take.addEventListener('click', () => {
      const day = dayOf(date);
      day.text = day.text ? `${day.text}\n\n${text}` : text;
      persist(day);
      render();
    });
    drop.addEventListener('click', () => { box.hidden = true; clear(box); });
    box.append(h('div', { class: 'muted' }, 'Vorschlag des Concierge:'), richText(text), h('div', { class: 'diary-row' }, take, drop));
  }

  // ---------- rendering ----------
  function renderExpenses(day) {
    const rates = trip.currency;
    const toBase = (e) => {
      const rate = e.currency === rates?.base ? 1 : rates?.rates.find((r) => r.code === e.currency)?.perBase;
      return rate ? e.amount / rate : 0;
    };
    const total = (day.expenses ?? []).reduce((sum, e) => sum + toBase(e), 0);

    const list = h('div', {});
    for (const [i, e] of (day.expenses ?? []).entries()) {
      list.append(h('div', { class: 'diary-row' },
        h('span', { class: 'diary-grow' }, `${e.amount} ${e.currency} · ${e.label || 'ohne Bezeichnung'}`),
        h('button', {
          type: 'button', class: 'diary-x', 'aria-label': 'Ausgabe entfernen',
          onclick: () => { day.expenses.splice(i, 1); persist(day); render(); },
        }, '✕')));
    }

    const label = h('input', { type: 'text', class: 'diary-input diary-grow', placeholder: 'Wofür?', maxlength: '80' });
    const amount = h('input', { type: 'number', class: 'diary-input short', placeholder: '0.00', min: '0', step: 'any', inputmode: 'decimal' });
    const codes = [rates?.base, ...(rates?.rates ?? []).map((r) => r.code)].filter(Boolean);
    const currency = h('select', { class: 'diary-input short' }, codes.map((c) => h('option', { value: c }, c)));
    currency.value = currencyForDate(trip, date) || codes[0] || '';
    const add = h('button', { type: 'button', class: 'diary-btn' }, '+');
    add.addEventListener('click', () => {
      const value = Number(String(amount.value).replace(',', '.'));
      if (!Number.isFinite(value) || value <= 0) return;
      day.expenses = [...(day.expenses ?? []), { label: label.value.trim(), amount: value, currency: currency.value }];
      persist(day);
      render();
    });

    return h('details', { class: 'info', open: Boolean(day.expenses?.length) },
      h('summary', {}, '💸 Ausgaben', total ? h('small', {}, ` · ${total.toFixed(2)} ${rates?.base ?? ''}`) : null),
      list,
      h('div', { class: 'diary-row' }, label, amount, currency, add));
  }

  function renderPhotos(day) {
    const grid = h('div', { class: 'diary-photos' });
    for (const p of day.photos ?? []) {
      const img = h('img', { alt: p.caption || 'Foto', loading: 'lazy' });
      photoSrc(p, img);
      grid.append(h('div', { class: 'diary-photo' }, img,
        h('button', { type: 'button', class: 'diary-x', 'aria-label': 'Foto löschen', onclick: () => removePhoto(p) }, '✕')));
    }
    for (const p of day.pendingPhotos ?? []) {
      grid.append(h('div', { class: 'diary-photo' },
        h('img', { src: p.thumb, alt: 'Foto, noch nicht hochgeladen' }),
        h('span', { class: 'diary-badge', title: 'Wird bei Internet hochgeladen' }, '⏳')));
    }

    const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    picker.addEventListener('change', () => {
      const files = [...(picker.files ?? [])];
      picker.value = '';
      if (files.length) addPhotos(files);
    });
    const pick = h('button', { type: 'button', class: 'diary-btn' }, '📷 Fotos hinzufügen');
    pick.addEventListener('click', () => picker.click());

    return h('div', {}, grid, h('div', { class: 'diary-row' }, pick, picker));
  }

  function render() {
    clear(root);
    root.append(h('h2', { class: 'section-title' }, '📔 Tagebuch'));

    const session = currentSession();
    if (!session) {
      const btn = h('button', { type: 'button', class: 'diary-btn' }, 'Entsperren');
      btn.addEventListener('click', () => openAiPanel());
      root.append(h('div', { class: 'city' }, h('div', { class: 'content' },
        h('p', { class: 'muted' }, 'Dein Tagebuch öffnet sich, sobald du mit Name und Zugangscode entsperrt hast. Danach bleibst du angemeldet.'),
        h('div', { class: 'diary-row' }, btn))));
      return;
    }

    const day = dayOf(date);
    const dayPicker = h('input', { type: 'date', class: 'diary-input', value: date });
    dayPicker.addEventListener('change', () => { date = dayPicker.value || date; render(); });
    const today = h('button', { type: 'button', class: 'diary-btn ghost' }, 'Heute');
    today.addEventListener('click', () => { date = iso(appNow()); render(); });

    const text = h('textarea', {
      class: 'diary-text', rows: '6', maxlength: String(MAX_TEXT),
      placeholder: 'Was war heute schön? Was willst du nicht vergessen?',
    });
    text.value = day.text || '';
    text.addEventListener('input', () => { day.text = text.value; queueSave(day); });

    const moods = h('div', { class: 'diary-moods' }, MOODS.map((m) => {
      const b = h('button', { type: 'button', class: `diary-mood${day.mood === m ? ' on' : ''}` }, m);
      b.addEventListener('click', () => { day.mood = day.mood === m ? '' : m; persist(day); render(); });
      return b;
    }));

    const draftBtn = h('button', { type: 'button', class: 'diary-btn ghost' }, '✨ Entwurf schreiben lassen');
    draftBtn.addEventListener('click', aiDraft);

    root.append(h('div', { class: 'city' }, h('div', { class: 'content' },
      h('div', { class: 'diary-row' }, dayPicker, today),
      h('div', { class: 'muted' }, `${session.user === 'deshira' ? 'Deshiras' : 'Albans'} Eintrag · ${formatLongDate(date)}`),
      moods,
      text,
      h('div', { class: 'diary-row' }, draftBtn),
      h('div', { class: 'diary-draft', hidden: true }),
      renderPhotos(day),
      renderExpenses(day),
      h('p', { class: 'muted diary-status' }, status))));
  }

  // ---------- start ----------
  (async () => {
    const stored = (await db.allDays()) ?? [];
    days = new Map(stored.map((d) => [d.date, d]));
    render();
    sync({ silent: true });
  })();

  window.addEventListener('online', () => sync({ silent: true }));
  window.addEventListener('asia:session', () => { render(); sync({ silent: true }); });
}
