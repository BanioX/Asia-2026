// Renders the offline travel guide from trip-data.json (cached by the service worker).
// Nothing here needs the network or the AI backend.
import { getTripStatus, formatRange, formatDayLabel, formatLongDate, daysBetween } from './trip-core.js';
import { appNow } from './app-config.js';
import { h, inline, clear } from './dom.js';
import { initAi } from './ai.js';
import { initDiary } from './diary.js';

const FAV_KEY = 'asiaFavorites';
const $ = (id) => document.getElementById(id);

function readFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
}
function writeFavs(set) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

const nights = (s) => daysBetween(s.from, s.to);
const visibleStops = (trip) => trip.stops.filter((s) => !s.hideCard);

function renderToday(trip) {
  const el = clear($('today'));
  const st = getTripStatus(trip, appNow());
  if (st.phase === 'before') {
    el.append(
      h('div', { class: 'eyebrow' }, 'COUNTDOWN'),
      h('div', { class: 'today-title' }, `Noch ${st.daysUntilStart} ${st.daysUntilStart === 1 ? 'Tag' : 'Tage'} bis ${st.next.name} ✈️`),
      h('div', { class: 'today-sub' }, `Abflug-Tag: ${formatLongDate(trip.start)}`),
    );
    return;
  }
  if (st.phase === 'after') {
    el.append(h('div', { class: 'today-title' }, `Willkommen zurück in ${trip.home} ❤️`));
    return;
  }
  el.append(
    h('div', { class: 'eyebrow' }, `HEUTE · ${formatLongDate(st.date).toUpperCase()}`),
    h('div', { class: 'today-title' }, `📍 ${st.current.map((s) => s.name).join(' → ')}`),
    st.today.length
      ? h('div', { class: 'today-plan' }, st.today.map((t) => h('div', {}, t.text)))
      : h('div', { class: 'today-sub' }, 'Heute steht nichts Festes im Plan.'),
    st.next ? h('div', { class: 'today-sub' }, `Als Nächstes: ${st.next.name} (ab ${formatDayLabel({ from: st.next.from })})`) : null,
  );
  const hotel = st.current[st.current.length - 1]?.hotel;
  if (hotel?.name) el.append(h('div', { class: 'today-sub' }, `🏨 ${hotel.name}`));
}

function renderRoute(trip) {
  clear($('routeList')).append(...visibleStops(trip).map((s) =>
    h('div', {}, h('b', {}, `${s.routeIcon} ${s.name}`), h('small', {}, `${formatRange(s.from, s.to)} · ${nights(s)} ${nights(s) === 1 ? 'Nacht' : 'Nächte'}`))));
  const notice = clear($('notice'));
  if (trip.notice) notice.append('⚠️ ', inline(trip.notice));
  else notice.remove();
}

function favButton(id, favs, onChange) {
  const btn = h('button', { class: 'fav', type: 'button', 'aria-label': 'Als Favorit merken' });
  const sync = () => {
    const on = favs.has(id);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.addEventListener('click', () => {
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    writeFavs(favs);
    sync();
    onChange();
  });
  sync();
  return btn;
}

/**
 * Landmark photos for a stop. Files that are not there yet drop out of the strip,
 * so the folders can be filled over time without the app looking broken.
 */
/**
 * Opens whatever maps app is installed. Google Maps does not work in mainland China,
 * Apple Maps does, so both are offered instead of guessing.
 */
function mapLinks(query, label = 'Karte öffnen:') {
  if (!query) return null;
  const q = encodeURIComponent(query);
  return h('div', { class: 'maps' },
    h('span', { class: 'muted' }, label),
    h('a', { class: 'map-btn', href: `https://www.google.com/maps/search/?api=1&query=${q}`, target: '_blank', rel: 'noopener' }, '🗺️ Google'),
    h('a', { class: 'map-btn', href: `https://maps.apple.com/?q=${q}`, target: '_blank', rel: 'noopener' }, '🍎 Apple'));
}

function renderGallery(stop) {
  if (!stop.gallery?.length) return null;
  const strip = h('div', { class: 'shots' });
  for (const g of stop.gallery) {
    const img = h('img', { src: g.file, alt: g.title, loading: 'lazy', decoding: 'async' });
    const link = h('a', {
      href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.title + ' ' + stop.name)}`,
      target: '_blank', rel: 'noopener', title: g.title + ' auf der Karte',
    }, img);
    const shot = h('figure', { class: 'shot' }, link, h('figcaption', {}, g.title));
    img.addEventListener('error', () => shot.remove());
    strip.append(shot);
  }
  return strip;
}

function renderCities(trip, favs) {
  const root = clear($('cities'));
  for (const s of visibleStops(trip)) {
    root.append(h('section', { class: 'city', id: `stop-${s.id}` },
      h('div', { class: `visual ${s.visualClass || ''}` }, s.visual),
      h('div', { class: 'content' },
        h('h2', {}, s.name),
        h('div', { class: 'sub' }, s.subtitle),
        s.intro ? h('p', {}, inline(s.intro)) : null,
        renderGallery(s),
        mapLinks(s.name),
        h('div', { class: 'grid' }, (s.highlights || []).map((hl, i) =>
          h('div', { class: 'mini' },
            favButton(`${s.id}:${i}`, favs, () => renderFavorites(trip, favs)),
            h('strong', {}, hl.label), h('span', {}, hl.value)))),
        s.days?.length ? h('details', { open: s.daysOpen },
          h('summary', {}, s.daysTitle || 'Tagesidee'),
          h('div', { class: 'day' },
            s.days.map((d) => h('div', {}, h('b', {}, formatDayLabel(d)), ' ', d.text)),
            s.note ? h('p', {}, s.note) : null)) : null)));
  }
}

function renderFavorites(trip, favs) {
  const root = clear($('favorites'));
  const items = [];
  for (const s of trip.stops) {
    (s.highlights || []).forEach((hl, i) => { if (favs.has(`${s.id}:${i}`)) items.push({ s, hl }); });
  }
  root.append(h('div', { class: 'city' }, h('div', { class: 'content' },
    h('h3', {}, '⭐ Favoriten'),
    items.length
      ? h('div', { class: 'list' }, items.map(({ s, hl }) => h('a', { class: 'row', href: `#stop-${s.id}` }, h('span', {}, hl.value), h('small', {}, s.name))))
      : h('p', { class: 'muted' }, 'Tippe bei einem Highlight auf ☆, um es hier zu merken.'))));
}

function field(label, value, opts = {}) {
  if (!value) return null;
  const content = opts.tel ? h('a', { href: `tel:${value.replace(/[^\d+]/g, '')}` }, value) : value;
  return h('div', { class: `kv ${opts.big ? 'big' : ''}` }, h('small', {}, label), h('div', {}, content));
}

function renderStays(trip) {
  const root = clear($('stays'));
  const st = getTripStatus(trip, appNow());
  const currentIds = new Set(st.current.map((s) => s.id));
  root.append(h('h3', { class: 'group-title' }, '🏨 Unterkünfte, Adressen & Transport'));
  for (const s of trip.stops) {
    const hotel = s.hotel || {};
    const rows = [
      field('Hotel', hotel.name),
      field('Adresse', hotel.address),
      field('Adresse (für Taxi zeigen)', hotel.addressLocal, { big: true }),
      field('Telefon', hotel.phone, { tel: true }),
      field('Hotel-Notizen', hotel.notes),
      hotel.address ? mapLinks(hotel.address + ', ' + s.name, 'Hotel auf der Karte:') : null,
      field('Transport', s.transport),
      field('Buchungsnotizen', s.bookingNotes),
    ].filter(Boolean);
    root.append(h('details', { class: 'info', open: currentIds.has(s.id) },
      h('summary', {}, `${s.routeIcon} ${s.name}`, h('small', {}, ` · ${formatRange(s.from, s.to)}`)),
      rows.length ? rows : h('p', { class: 'muted' }, 'Noch nichts eingetragen.')));
  }
}

/** Local time wherever the itinerary goes, plus home - handy for calling Switzerland. */
function renderClocks(trip) {
  const root = clear($('clocks'));
  root.append(h('h3', { class: 'group-title' }, '🕐 Uhrzeiten'));
  const zones = [{ name: trip.home, tz: 'Europe/Zurich' }, ...visibleStops(trip).map((s) => ({ name: s.name, tz: s.tz }))];
  const grid = h('div', { class: 'grid' });
  const cells = [];
  const seen = new Set();
  for (const z of zones) {
    if (!z.tz || seen.has(z.tz)) continue;
    seen.add(z.tz);
    const value = h('strong', {});
    cells.push({ tz: z.tz, el: value });
    grid.append(h('div', { class: 'mini' }, value, h('span', {}, z.name)));
  }
  const tick = () => {
    const now = appNow();
    for (const c of cells) {
      try {
        c.el.textContent = new Intl.DateTimeFormat('de-CH', { timeZone: c.tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(now);
      } catch {
        c.el.textContent = '–';
      }
    }
  };
  tick();
  setInterval(tick, 30000);
  root.append(grid);
}

/** Plugs, paying, tipping, tap water - the things you look up once per country. */
function renderFacts(trip) {
  const root = clear($('facts'));
  if (!trip.countryFacts) return;
  root.append(h('h3', { class: 'group-title' }, '🧾 Länder-Spickzettel'));
  for (const code of [...new Set(visibleStops(trip).map((s) => s.country))]) {
    const f = trip.countryFacts[code];
    if (!f) continue;
    root.append(h('details', { class: 'info' },
      h('summary', {}, f.flag + ' ' + f.name),
      h('div', { class: 'grid' }, f.items.map((it) => h('div', { class: 'mini' }, h('strong', {}, it.label), h('span', {}, it.value)))),
      f.note ? h('p', { class: 'muted' }, f.note) : null));
  }
}

function renderPhrases(trip) {
  const root = clear($('phrases'));
  root.append(h('h3', { class: 'group-title' }, '🗣️ Wichtige Sätze'));
  for (const g of trip.phrases || []) {
    root.append(h('details', { class: 'info' },
      h('summary', {}, g.title),
      g.items.map((p) => h('div', { class: 'phrase' },
        h('div', { class: 'phrase-local', lang: g.id === 'ja' ? 'ja' : g.id === 'yue' ? 'zh-HK' : 'zh-CN' }, p.local),
        h('div', { class: 'phrase-roman' }, p.roman),
        h('div', { class: 'phrase-de' }, p.de))),
      g.note ? h('p', { class: 'muted' }, g.note) : null));
  }
}

function renderEmergency(trip) {
  const root = clear($('emergency'));
  root.append(h('h3', { class: 'group-title' }, '🚑 Notfall'),
    h('div', { class: 'grid' }, (trip.emergency || []).map((e) => h('div', { class: 'mini' },
      h('strong', {}, e.title),
      e.numbers.map((n) => h('a', { class: 'tel', href: `tel:${n.number}` }, h('b', {}, n.number), ` ${n.label}`))))),
    trip.emergencyNote ? h('p', { class: 'muted' }, trip.emergencyNote) : null);
}

function money(n, code) {
  const d = code === 'JPY' ? 0 : 2;
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
}

/** Offline converter: every rate is stored as "units per 1 CHF", so we go through CHF. */
function renderCurrency(trip) {
  const root = clear($('currency'));
  const cur = trip.currency;
  if (!cur) return;
  const all = [{ code: cur.base, label: 'Schweizer Franken', flag: '🇨🇭', perBase: 1 }, ...cur.rates];

  const amount = h('input', { class: 'cur-input', type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: '10', 'aria-label': 'Betrag' });
  const from = h('select', { class: 'cur-select', 'aria-label': 'Währung' }, all.map((c) => h('option', { value: c.code }, `${c.flag} ${c.code}`)));
  try { from.value = localStorage.getItem('asiaCurrency') || cur.base; } catch { from.value = cur.base; }
  if (!all.some((c) => c.code === from.value)) from.value = cur.base;
  const out = h('div', { class: 'grid cur-out' });

  function update() {
    clear(out);
    try { localStorage.setItem('asiaCurrency', from.value); } catch { /* private mode */ }
    const n = Number(String(amount.value).replace(',', '.'));
    const src = all.find((c) => c.code === from.value) || all[0];
    if (!Number.isFinite(n) || n < 0) return;
    const inBase = n / src.perBase;
    for (const c of all) {
      if (c.code === src.code) continue;
      out.append(h('div', { class: 'mini' }, h('strong', {}, `${c.flag} ${money(inBase * c.perBase, c.code)} ${c.code}`), h('span', {}, c.label)));
    }
  }
  amount.addEventListener('input', update);
  from.addEventListener('change', update);

  root.append(
    h('h3', { class: 'group-title' }, '💱 Währungsrechner'),
    h('div', { class: 'cur-row' }, amount, from),
    out,
    h('p', { class: 'muted' }, `Kurse vom ${formatLongDate(cur.updated)}. ${cur.note || ''}`),
  );
  update();
}

async function loadTrip() {
  const res = await fetch('./trip-data.json');
  if (!res.ok) throw new Error(`trip-data.json: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  let trip;
  try {
    trip = await loadTrip();
  } catch (err) {
    console.error(err);
    $('today').textContent = 'Reiseplan konnte nicht geladen werden. Bitte einmal mit Internet öffnen.';
    return;
  }
  const favs = readFavs();
  renderToday(trip);
  renderRoute(trip);
  renderCities(trip, favs);
  renderFavorites(trip, favs);
  renderStays(trip);
  renderCurrency(trip);
  renderClocks(trip);
  renderFacts(trip);
  initDiary(trip);
  renderPhrases(trip);
  renderEmergency(trip);
  const checklist = clear($('checklist'));
  checklist.append(...(trip.checklist || []).map((c) => h('div', { class: 'mini' }, h('strong', {}, c.label), h('span', {}, c.value))));
  $('sources').textContent = trip.sources || '';
  initAi(trip);
}

main();
