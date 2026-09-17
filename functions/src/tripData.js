// Loads the itinerary: live copy from GitHub Pages (so edits to trip-data.json reach the
// AI without a redeploy), cached for a few minutes, with the copy bundled at deploy time
// (functions/shared/trip-data.json, same file) as fallback.

export function isTripData(v) {
  return Boolean(v && Array.isArray(v.stops) && v.stops.length > 0 && typeof v.start === 'string' && typeof v.end === 'string'
    && v.stops.every((s) => s && typeof s.name === 'string' && typeof s.country === 'string' && typeof s.tz === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(s.from) && /^\d{4}-\d{2}-\d{2}$/.test(s.to)));
}

export function createTripDataLoader({ url, bundled, fetchImpl = fetch, ttlMs = 10 * 60 * 1000, timeoutMs = 2500 }) {
  let cached = null;
  let cachedAt = 0;

  return async function loadTripData(now = Date.now()) {
    if (cached && now - cachedAt < ttlMs) return cached;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!isTripData(data)) throw new Error('invalid trip data');
      cached = data;
    } catch (err) {
      console.warn('trip data: using bundled copy', String(err?.message ?? err));
      cached = cached ?? bundled;
    }
    cachedAt = now;
    return cached;
  };
}
