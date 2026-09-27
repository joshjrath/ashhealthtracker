/* ──────────────────────────────────────────────────────────────────────────
   One person, one password — the same shape as the Specular dashboard.
   A session is "expiry.signature" in an httpOnly cookie; the upload
   endpoint for Apple Health uses its own token so the phone never holds
   the site password.
   ────────────────────────────────────────────────────────────────────────── */
import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const COOKIE = "ash_session";

export function createAuth({ password, secret, ingestToken }) {
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
  const same = (a, b) => {
    const x = createHmac("sha256", secret).update(String(a ?? "")).digest();
    const y = createHmac("sha256", secret).update(String(b ?? "")).digest();
    return timingSafeEqual(x, y);
  };

  return {
    ttlSeconds: TTL_MS / 1000,
    issue() {
      const payload = String(Date.now() + TTL_MS);
      return `${payload}.${sign(payload)}`;
    },
    verify(token) {
      if (!token) return false;
      const [payload, sig] = String(token).split(".");
      if (!payload || !sig) return false;
      const a = Buffer.from(sign(payload)), b = Buffer.from(sig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      return Number(payload) > Date.now();
    },
    checkPassword: (given) => !!password && same(given, password),
    checkIngest: (given) => !!ingestToken && !!given && same(given, ingestToken),
  };
}

export function readCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Five tries a minute per address, then a pause. */
export function limiter(max = 5, windowMs = 60_000) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 1000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}
