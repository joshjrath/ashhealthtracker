/* ──────────────────────────────────────────────────────────────────────────
   One person, one password — the same shape as the Specular dashboard.

   The password starts as the APP_PASSWORD variable. Once it's changed in
   Settings, a scrypt hash in the database takes over. A session cookie is
   "expiry.epoch.signature"; bumping the epoch (a password change, or
   "sign out everywhere") retires every cookie issued before it.

   Apple Health uploads use their own tokens, created and revoked in
   Settings, so the phone never holds the site password.
   ────────────────────────────────────────────────────────────────────────── */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const COOKIE = "ash_session";
export const TTL_SECONDS = TTL_MS / 1000;

/** Equal-length digests first, so neither length nor content leaks through timing. */
export function sameSecret(a, b, key = "cmp") {
  const x = createHmac("sha256", key).update(String(a ?? "")).digest();
  const y = createHmac("sha256", key).update(String(b ?? "")).digest();
  return timingSafeEqual(x, y);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function checkHash(password, rec) {
  if (!rec?.hash || !rec?.salt) return false;
  const given = scryptSync(String(password ?? ""), Buffer.from(rec.salt, "hex"), 32);
  const want = Buffer.from(rec.hash, "hex");
  return want.length === given.length && timingSafeEqual(given, want);
}

export function sessions(secret) {
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    issue(epoch = 0) {
      const payload = `${Date.now() + TTL_MS}.${epoch}`;
      return `${payload}.${sign(payload)}`;
    },
    verify(token, epoch = 0) {
      const parts = String(token || "").split(".");
      if (parts.length !== 3) return false;
      const [expiry, ep, sig] = parts;
      const a = Buffer.from(sign(`${expiry}.${ep}`)), b = Buffer.from(sig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      return Number(expiry) > Date.now() && Number(ep) === epoch;
    },
  };
}

/** A new upload token: recognisable prefix, 32 random bytes. */
export const newToken = () => `ahx_${randomBytes(32).toString("base64url")}`;

export function readCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip a mangled cookie */ }
    }
  }
  return out;
}

/** N failures per window per key, then a pause. Successes don't count. */
export function limiter(max = 5, windowMs = 60_000) {
  const fails = new Map();
  const live = (key) => {
    const f = fails.get(key);
    if (f && f.reset < Date.now()) { fails.delete(key); return null; }
    return f;
  };
  return {
    blocked: (key) => (live(key)?.n ?? 0) >= max,
    fail(key) {
      const f = live(key);
      if (f) f.n += 1;
      else fails.set(key, { n: 1, reset: Date.now() + windowMs });
      if (fails.size > 1000) for (const [k] of fails) live(k);
    },
  };
}
