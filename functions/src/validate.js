// Payload validation. Every function returns { ok: true, value } or { ok: false, code, message }.

const ACTIONS = ['chat', 'today', 'date_night', 'rain', 'food', 'translate', 'tomorrow', 'diary'];

const fail = (code, message) => ({ ok: false, code, message });

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateLogin(body, { users }) {
  if (!isPlainObject(body)) return fail('invalid_request', 'Ungültige Anfrage.');
  const user = typeof body.user === 'string' ? body.user.toLowerCase() : '';
  if (!users.includes(user)) return fail('invalid_request', 'Unbekannter Name.');
  if (typeof body.code !== 'string' || body.code.length === 0 || body.code.length > 200) {
    return fail('invalid_request', 'Bitte Zugangscode eingeben.');
  }
  return { ok: true, value: { user, code: body.code } };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shared by the AI question and the diary: one inline base64 image. */
function checkImage(img, limits) {
  if (!isPlainObject(img)) return fail('invalid_request', 'Ungültiges Bildformat.');
  if (!limits.imageMimeTypes.includes(img.mimeType)) return fail('invalid_request', 'Dieses Bildformat wird nicht unterstützt (JPEG, PNG oder WebP).');
  if (typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) return fail('invalid_request', 'Ungültige Bilddaten.');
  if (img.data.length > limits.maxImageBase64Chars) return fail('image_too_large', 'Das Foto ist zu gross – bitte ein kleineres senden.');
  return { ok: true, value: { mimeType: img.mimeType, data: img.data } };
}

/** One diary day: the written part. Photos are added separately. */
export function validateDiaryDay(body, limits) {
  if (!isPlainObject(body)) return fail('invalid_request', 'Ungültige Anfrage.');
  if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) return fail('invalid_request', 'Ungültiges Datum.');

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > limits.maxDiaryTextChars) {
    return fail('entry_too_long', `Der Eintrag ist zu lang (max. ${limits.maxDiaryTextChars} Zeichen).`);
  }
  const mood = typeof body.mood === 'string' ? body.mood.trim().slice(0, 60) : '';

  const expenses = [];
  if (body.expenses !== undefined && body.expenses !== null) {
    if (!Array.isArray(body.expenses)) return fail('invalid_request', 'Ungültige Ausgabenliste.');
    if (body.expenses.length > limits.maxDiaryExpenses) return fail('invalid_request', `Maximal ${limits.maxDiaryExpenses} Ausgaben pro Tag.`);
    for (const e of body.expenses) {
      if (!isPlainObject(e)) return fail('invalid_request', 'Ungültige Ausgabe.');
      const amount = Number(e.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) return fail('invalid_request', 'Ungültiger Betrag.');
      const label = typeof e.label === 'string' ? e.label.trim().slice(0, 80) : '';
      const currency = typeof e.currency === 'string' ? e.currency.trim().slice(0, 4).toUpperCase() : '';
      if (!label && !amount) continue; // empty row from the form
      expenses.push({ label, amount, currency });
    }
  }
  return { ok: true, value: { date: body.date, text, mood, expenses } };
}

/** A photo being added to a diary day. */
export function validateDiaryPhoto(body, limits) {
  if (!isPlainObject(body)) return fail('invalid_request', 'Ungültige Anfrage.');
  if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) return fail('invalid_request', 'Ungültiges Datum.');
  const img = checkImage(body.image, limits);
  if (!img.ok) return img;
  const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 200) : '';
  return { ok: true, value: { date: body.date, caption, ...img.value } };
}

/** Pointer to one existing photo. */
export function validateDiaryPhotoRef(body) {
  if (!isPlainObject(body)) return fail('invalid_request', 'Ungültige Anfrage.');
  if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) return fail('invalid_request', 'Ungültiges Datum.');
  if (typeof body.id !== 'string' || body.id.length < 8 || body.id.length > 64 || !/^[A-Za-z0-9-]+$/.test(body.id)) {
    return fail('invalid_request', 'Ungültige Foto-Kennung.');
  }
  return { ok: true, value: { date: body.date, id: body.id } };
}

export function validateAiRequest(body, limits) {
  if (!isPlainObject(body)) return fail('invalid_request', 'Ungültige Anfrage.');
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) return fail('invalid_request', 'Keine Nachricht.');
  if (messages.length > limits.maxHistoryMessages + 1) return fail('invalid_request', 'Chatverlauf zu lang.');

  const action = body.action ?? 'chat';
  if (!ACTIONS.includes(action)) return fail('invalid_request', 'Unbekannte Aktion.');

  let total = 0;
  const clean = [];
  for (const m of messages) {
    if (!isPlainObject(m) || (m.role !== 'user' && m.role !== 'model') || typeof m.text !== 'string') {
      return fail('invalid_request', 'Ungültiges Nachrichtenformat.');
    }
    const text = m.text.trim();
    if (!text) return fail('invalid_request', 'Leere Nachricht.');
    if (text.length > limits.maxHistoryMessageChars) return fail('prompt_too_long', 'Eine Nachricht im Verlauf ist zu lang.');
    total += text.length;
    clean.push({ role: m.role, text });
  }

  const last = clean[clean.length - 1];
  if (last.role !== 'user') return fail('invalid_request', 'Die letzte Nachricht muss eine Frage sein.');
  if (last.text.length > limits.maxPromptChars) {
    return fail('prompt_too_long', `Die Frage ist zu lang (max. ${limits.maxPromptChars} Zeichen).`);
  }
  if (total > limits.maxTotalChars) return fail('prompt_too_long', 'Der Chatverlauf ist zu lang.');

  const value = { messages: clean, action };

  // Optional: one inline photo, always belonging to the newest question.
  if (body.image !== undefined && body.image !== null) {
    const img = checkImage(body.image, limits);
    if (!img.ok) return img;
    value.image = img.value;
  }

  return { ok: true, value };
}
