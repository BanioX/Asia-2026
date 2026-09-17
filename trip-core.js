// Shared trip logic (ES module) used by the PWA (app.js, ai.js) and the backend
// (functions/, copied there at deploy/test time). Pure functions only – no DOM, no I/O.

const DAY_MS = 86400000;
const MONTHS_DE = ['Jan', 'Feb', 'März', 'Apr', 'Mai', 'Juni', 'Juli', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** 'YYYY-MM-DD' of `now` in the given IANA time zone. */
export function localDate(now, tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function toUtc(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / DAY_MS);
}

export function addDays(isoDate, n) {
  return new Date(toUtc(isoDate) + n * DAY_MS).toISOString().slice(0, 10);
}

/** '25–29 Sep', '29 Sep–2 Okt' */
export function formatRange(fromIso, toIso) {
  const [, fm, fd] = fromIso.split('-').map(Number);
  const [, tm, td] = toIso.split('-').map(Number);
  if (fm === tm) return `${fd}–${td} ${MONTHS_DE[tm - 1]}`;
  return `${fd} ${MONTHS_DE[fm - 1]}–${td} ${MONTHS_DE[tm - 1]}`;
}

/** '07.10' or '10.–15.10' */
export function formatDayLabel(day) {
  const short = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  if (day.to && day.to !== day.from) return `${day.from.slice(8, 10)}.–${short(day.to)}`;
  return short(day.from);
}

/** '7. Oktober 2026' */
export function formatLongDate(isoDate) {
  return new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(toUtc(isoDate)));
}

function dayMatches(day, date) {
  const to = day.to || day.from;
  return day.from <= date && date <= to;
}

/**
 * Where are we right now according to the itinerary?
 * Each stop is evaluated in its own time zone. On travel days two stops match
 * (the one being left and the one being reached); both are returned.
 */
export function getTripStatus(trip, now = new Date()) {
  const stops = trip.stops;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const startDate = localDate(now, first.tz);
  const endDate = localDate(now, last.tz);

  if (startDate < trip.start) {
    return {
      phase: 'before',
      date: localDate(now, 'Europe/Zurich'),
      daysUntilStart: daysBetween(startDate, trip.start),
      current: [],
      next: first,
      today: [],
    };
  }
  if (endDate > trip.end) {
    return { phase: 'after', date: localDate(now, 'Europe/Zurich'), current: [], next: null, today: [] };
  }

  const current = stops.filter((s) => {
    const d = localDate(now, s.tz);
    return s.from <= d && d <= s.to;
  });
  const lastCurrent = current[current.length - 1];
  const date = lastCurrent ? localDate(now, lastCurrent.tz) : startDate;
  const next = stops.find((s) => s.from > date) || null;

  const today = [];
  for (const s of current) {
    const d = localDate(now, s.tz);
    for (const day of s.days || []) {
      if (dayMatches(day, d) && !today.some((t) => t.text === day.text)) today.push({ stop: s, ...day });
    }
  }
  return { phase: 'during', date, current, next, today };
}

/**
 * Is the AI concierge officially available where the itinerary says we are?
 * `supportedCountries` is an allowlist (ISO-3166 alpha-2) from the AI provider config.
 * Travel days count as blocked if either side is unsupported (fail closed).
 */
export function getAiRegionStatus(trip, now, supportedCountries) {
  const status = getTripStatus(trip, now);
  const places = status.phase === 'during' ? status.current : [];
  const blockedStop = places.find((s) => !supportedCountries.includes(s.country));
  if (!blockedStop) return { blocked: false };

  // First date on which no unsupported stop is active any more.
  let lastBlocked = blockedStop.to;
  for (const s of trip.stops) {
    if (s.from <= lastBlocked && !supportedCountries.includes(s.country) && s.to > lastBlocked) lastBlocked = s.to;
  }
  return { blocked: true, country: blockedStop.country, stop: blockedStop.name, availableFrom: addDays(lastBlocked, 1) };
}

/** Compact plain-text itinerary + "right now" block for the AI system prompt. */
export function buildTravelContext(trip, now = new Date()) {
  const lines = [];
  lines.push(`Travellers: ${trip.travellers.join(' & ')}`);
  lines.push(`Trip: ${formatLongDate(trip.start)} – ${formatLongDate(trip.end)}, home: ${trip.home}`);
  lines.push(`Route: ${trip.stops.map((s) => s.name).join(' → ')}`);
  lines.push('');
  lines.push('Itinerary:');
  for (const s of trip.stops) {
    lines.push(`- ${s.name} (${s.country}), ${s.from} to ${s.to}${s.subtitle ? ` – ${s.subtitle}` : ''}`);
    if (s.highlights?.length) lines.push(`  Highlights: ${s.highlights.map((h) => `${stripEmoji(h.label)}: ${h.value}`).join('; ')}`);
    for (const d of s.days || []) lines.push(`  ${formatDayLabel(d)}: ${d.text}`);
    const h = s.hotel || {};
    if (h.name) lines.push(`  Hotel: ${[h.name, h.address, h.addressLocal].filter(Boolean).join(', ')}`);
    if (h.notes) lines.push(`  Hotel notes: ${h.notes}`);
    if (s.transport) lines.push(`  Transport: ${s.transport}`);
    if (s.bookingNotes) lines.push(`  Booking notes: ${s.bookingNotes}`);
    if (s.note) lines.push(`  Note: ${s.note}`);
  }
  if (trip.notice) lines.push('', `Planning note: ${trip.notice.replace(/\*\*/g, '')}`);

  const st = getTripStatus(trip, now);
  lines.push('', 'Current context:');
  lines.push(`Date: ${formatLongDate(st.date)}`);
  if (st.phase === 'before') {
    lines.push(`Status: Trip has not started yet (${st.daysUntilStart} days to go). Currently at home in ${trip.home}.`);
    lines.push(`Next destination: ${st.next.name} (from ${st.next.from})`);
  } else if (st.phase === 'after') {
    lines.push(`Status: Trip is over, back home in ${trip.home}.`);
  } else {
    const names = st.current.map((s) => s.name);
    lines.push(names.length > 1
      ? `Current destination: travel day ${names.join(' → ')}`
      : `Current destination: ${names[0] || 'unknown'}`);
    lines.push(`Today's itinerary: ${st.today.length ? st.today.map((t) => t.text).join(' / ') : 'nothing planned'}`);
    lines.push(`Next destination: ${st.next ? `${st.next.name} (from ${st.next.from})` : `${trip.home} (end of trip)`}`);
  }
  return lines.join('\n');
}

function stripEmoji(label) {
  return label.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}
