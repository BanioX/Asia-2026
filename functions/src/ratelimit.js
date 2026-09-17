// Fixed-window rate limiting.
// rule = { limit, windowSeconds }; result = { allowed, count, retryAfterSeconds }
// hit()  counts the attempt and reports whether it was within the limit.
// peek() only reports whether one more attempt would still be allowed.

function evaluate(state, rule, now) {
  const windowMs = rule.windowSeconds * 1000;
  const fresh = !state || now - state.windowStart >= windowMs;
  const windowStart = fresh ? now : state.windowStart;
  const count = fresh ? 0 : state.count;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
  return { windowStart, count, retryAfterSeconds, expireAt: new Date(windowStart + windowMs) };
}

export class MemoryRateLimiter {
  constructor() {
    this.store = new Map();
  }

  async hit(key, rule, now = Date.now()) {
    const s = evaluate(this.store.get(key), rule, now);
    const count = s.count + 1;
    this.store.set(key, { windowStart: s.windowStart, count });
    return { allowed: count <= rule.limit, count, retryAfterSeconds: s.retryAfterSeconds };
  }

  async peek(key, rule, now = Date.now()) {
    const s = evaluate(this.store.get(key), rule, now);
    return { allowed: s.count < rule.limit, count: s.count, retryAfterSeconds: s.retryAfterSeconds };
  }
}

/** Stores counters in Firestore collection `rateLimits` (server-side only, Admin SDK). */
export class FirestoreRateLimiter {
  constructor(db, collection = 'rateLimits') {
    this.db = db;
    this.collection = collection;
  }

  ref(key) {
    return this.db.collection(this.collection).doc(key);
  }

  async hit(key, rule, now = Date.now()) {
    const ref = this.ref(key);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const s = evaluate(snap.exists ? snap.data() : null, rule, now);
      const count = s.count + 1;
      tx.set(ref, { windowStart: s.windowStart, count, expireAt: s.expireAt });
      return { allowed: count <= rule.limit, count, retryAfterSeconds: s.retryAfterSeconds };
    });
  }

  async peek(key, rule, now = Date.now()) {
    const snap = await this.ref(key).get();
    const s = evaluate(snap.exists ? snap.data() : null, rule, now);
    return { allowed: s.count < rule.limit, count: s.count, retryAfterSeconds: s.retryAfterSeconds };
  }
}
