// Payload validation. Every function returns { ok: true, value } or { ok: false, code, message }.

const ACTIONS = ['chat', 'today', 'date_night', 'rain', 'food', 'translate', 'tomorrow'];

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

  return { ok: true, value: { messages: clean, action } };
}
