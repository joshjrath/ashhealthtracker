/* ──────────────────────────────────────────────────────────────────────────
   The web server: the dashboard's static files behind a login, a small JSON
   API for the page, and /api/ingest for Apple Health.

     GET  /healthz                    public   liveness + database check
     GET  /login  POST /login         public   the password page
     POST /logout
     POST /api/ingest                 token    Apple Health → merged into days
     GET  /api/state                  session  everything the page draws
     PUT  /api/days/:key              session  save what you logged (the day's manual bucket)
     DELETE /api/days/:key            session  clear what you logged; Apple's data stays
     DELETE /api/days                 session  erase every day
     PUT  /api/goals                  session
     POST /api/import                 session  replace all days (+ goals)
     GET  /api/review                 session  pre-provenance food/sleep awaiting a decision
     POST /api/review                 session  { keep: [keys], reject: [keys] }

   Settings — everything that used to mean editing Railway variables:
     GET  /api/settings               session  tokens (masked), password source, prefs
     PUT  /api/prefs                  session  dashboard defaults
     POST /api/tokens                 session  new upload token { name }
     GET  /api/tokens/:id             session  reveal one token
     PUT  /api/tokens/:id             session  rename { name }
     POST /api/tokens/:id/rotate      session  new value, same name
     DELETE /api/tokens/:id           session
     PUT  /api/password               session  { current, next }
     POST /api/sessions/revoke        session  sign out every other device
   ────────────────────────────────────────────────────────────────────────── */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { COOKIE, TTL_SECONDS, sessions, sameSecret, hashPassword, checkHash, newToken, readCookies, limiter } from "./auth.mjs";
import { parseIngest } from "./apple.mjs";
import { DEFAULT_GOALS, GOAL_IDS } from "../js/metrics.js";
import { cleanManual, cleanStored, migrateDay, reviewItems, applyReview } from "../js/sources.js";

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 40 * 1024 * 1024; // a 90-day per-sample export can run to tens of MB
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

/** What a dashboard default may be set to. */
const PREFS = {
  weightRange: ["30", "90", "all"],
  trendRange: [7, 30, 90],
  trendMetric: ["calories", "protein", "carbs", "fat", "fiber"],
  sleepN: [7, 14],
  showSample: [true, false],
};
export const DEFAULT_PREFS = { weightRange: "90", trendRange: 30, trendMetric: "calories", sleepN: 7, showSample: true };

/**
 * `password` and `ingestToken` are the Railway variables: the starting
 * password and a fallback upload token. Settings saved in the database win.
 */
export async function createApp({ store, root, password, secret, ingestToken, requireAuth }) {
  const sess = sessions(secret);
  const loginLimit = limiter(5, 60_000);
  const pwLimit = limiter(5, 60_000);

  // Held in memory (one instance) and written through to the database.
  const cfg = {
    auth: (await store.getMeta("auth")) || null, // { salt, hash, epoch, updatedAt }
    tokens: (await store.getMeta("tokens")) || [], // [{ id, name, token, createdAt, lastUsedAt, lastSync }]
    prefs: { ...DEFAULT_PREFS, ...((await store.getMeta("prefs")) || {}) },
  };
  await migrate(store);
  const epoch = () => cfg.auth?.epoch ?? 0;
  const hasPassword = () => !!(cfg.auth?.hash || password);
  const isOpen = () => !hasPassword() && !requireAuth; // local use with no password anywhere
  const checkPassword = (given) => (cfg.auth?.hash ? checkHash(given, cfg.auth) : !!password && sameSecret(given, password, secret));
  const saveAuth = async (next) => { cfg.auth = next; await store.setMeta("auth", next); };
  const saveTokens = async () => store.setMeta("tokens", cfg.tokens);

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const method = req.method;

    if (path === "/healthz") {
      await store.ping();
      return send(res, 200, "ok", "text/plain");
    }
    if (!hasPassword() && requireAuth) {
      return send(res, 503, "APP_PASSWORD is not set. Add it in Railway → Variables, then redeploy.", "text/plain");
    }

    if (path === "/api/ingest") {
      if (method !== "POST") return json(res, 405, { error: "POST only" });
      const given = bearer(req) ?? req.headers["x-ingest-token"] ?? url.searchParams.get("token");
      if (!cfg.tokens.length && !ingestToken) return json(res, 503, { error: "No upload token yet: create one in Settings → Apple Health" });
      // Check every token, so the time taken doesn't say which one matched.
      let match = null;
      for (const t of cfg.tokens) if (sameSecret(given, t.token, secret) && !match) match = t;
      const envMatch = !!ingestToken && sameSecret(given, ingestToken, secret);
      if (!given || (!match && !envMatch)) return json(res, 401, { error: "Bad or missing token" });
      let days, report;
      try {
        ({ days, report } = parseIngest(await readJson(req)));
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
      const keys = Object.keys(days).sort();
      if (keys.length) await store.mergeApple(days);
      await recordSeen(report);
      const source = /auto.?export/i.test(req.headers["user-agent"] || "") ? "Health Auto Export" : "Apple Health";
      const lastSync = {
        at: new Date().toISOString(), source, days: keys.length, from: keys[0] ?? null, to: keys.at(-1) ?? null,
        workouts: report.workouts, ignored: Object.keys(report.ignored),
      };
      await store.setMeta("lastSync", { ...lastSync, token: match ? match.name : "Railway variable" });
      if (match) {
        match.lastUsedAt = lastSync.at;
        match.lastSync = lastSync;
        await saveTokens();
      }
      return json(res, 200, { ok: true, ...lastSync });
    }

    if (path === "/login") {
      if (method === "GET") return send(res, 200, loginPage(), "text/html; charset=utf-8");
      if (method === "POST") {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        if (loginLimit.blocked(ip)) return send(res, 429, loginPage("Too many tries. Wait a minute."), "text/html; charset=utf-8");
        const form = new URLSearchParams(await readText(req, 10_000));
        if (!checkPassword(form.get("password"))) {
          loginLimit.fail(ip);
          return send(res, 401, loginPage("That's not it."), "text/html; charset=utf-8");
        }
        res.setHeader("set-cookie", cookie(req, sess.issue(epoch()), TTL_SECONDS));
        return redirect(res, "/");
      }
    }
    if (path === "/logout" && method === "POST") {
      res.setHeader("set-cookie", cookie(req, "", 0));
      return redirect(res, "/login");
    }

    const signedIn = isOpen() || sess.verify(readCookies(req.headers.cookie)[COOKIE], epoch());
    if (!signedIn) {
      if (path.startsWith("/api/")) return json(res, 401, { error: "Signed out" });
      return redirect(res, "/login");
    }

    if (path.startsWith("/api/")) {
      // Cross-site pages can't send a JSON body without a preflight this
      // server never approves, so requiring JSON on writes stops CSRF.
      if ((method === "POST" || method === "PUT") && !/^application\/json\b/.test(req.headers["content-type"] || "")) {
        return json(res, 415, { error: "Send application/json" });
      }
      return api(req, res, method, path);
    }

    if (method !== "GET" && method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    return serveStatic(res, path);
  }

  async function api(req, res, method, path) {
    if (path === "/api/state" && method === "GET") {
      const s = await store.getAll();
      return json(res, 200, {
        days: s.days, goals: { ...DEFAULT_GOALS, ...(s.goals || {}) }, lastSync: s.lastSync,
        prefs: cfg.prefs, storage: store.kind, open: isOpen(),
      });
    }
    if (path.startsWith("/api/settings") || path.startsWith("/api/tokens") || path.startsWith("/api/prefs")
      || path === "/api/password" || path === "/api/sessions/revoke") {
      return settingsApi(req, res, method, path);
    }
    const m = path.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})$/);
    if (m && KEY_RE.test(m[1])) {
      if (method === "PUT") {
        const manual = cleanManual(await readJson(req));
        await store.putManual(m[1], manual);
        return json(res, 200, { ok: true, manual });
      }
      if (method === "DELETE") {
        await store.putManual(m[1], {});
        return json(res, 200, { ok: true });
      }
    }
    if (path === "/api/days" && method === "DELETE") {
      await store.replaceDays({});
      return json(res, 200, { ok: true });
    }
    if (path === "/api/goals" && method === "PUT") {
      const goals = cleanGoals(await readJson(req));
      await store.setMeta("goals", goals);
      return json(res, 200, { ok: true, goals });
    }
    if (path === "/api/import" && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.days !== "object" || Array.isArray(body.days)) return json(res, 400, { error: "Not an Ash Health export" });
      const days = {};
      for (const [k, d] of Object.entries(body.days)) if (KEY_RE.test(k)) days[k] = cleanStored(d);
      await store.replaceDays(days);
      if (body.goals) await store.setMeta("goals", cleanGoals(body.goals));
      return json(res, 200, { ok: true, days: Object.keys(days).length });
    }
    if (path === "/api/review" && method === "GET") {
      return json(res, 200, { items: reviewItems((await store.getAll()).days) });
    }
    if (path === "/api/review" && method === "POST") {
      const body = await readJson(req);
      const { days } = await store.getAll();
      let done = 0;
      for (const [list, keep] of [[body?.keep, true], [body?.reject, false]]) {
        for (const key of Array.isArray(list) ? list : []) {
          if (!KEY_RE.test(key) || !days[key]) continue;
          await store.putDay(key, applyReview(days[key], keep));
          done += 1;
        }
      }
      return json(res, 200, { ok: true, done, items: reviewItems((await store.getAll()).days) });
    }
    return json(res, 404, { error: "Not found" });
  }

  /** A running tally of every metric and workout field the phone has sent. */
  async function recordSeen(report) {
    const seen = (await store.getMeta("fieldsSeen")) || { metrics: {}, workoutFields: {} };
    const at = new Date().toISOString();
    for (const [kind, accepted] of [[report.accepted, true], [report.ignored, false]]) {
      for (const [name, n] of Object.entries(kind)) {
        const m = seen.metrics[name] || { samples: 0 };
        seen.metrics[name] = { samples: m.samples + n, accepted, lastSeen: at };
      }
    }
    for (const [f, n] of Object.entries(report.workoutFields)) seen.workoutFields[f] = (seen.workoutFields[f] || 0) + n;
    seen.workouts = (seen.workouts || 0) + report.workouts;
    await store.setMeta("fieldsSeen", seen);
  }

  async function settingsApi(req, res, method, path) {
    const view = (t) => ({
      id: t.id, name: t.name, preview: `${t.token.slice(0, 4)}…${t.token.slice(-4)}`,
      createdAt: t.createdAt, lastUsedAt: t.lastUsedAt ?? null, lastSync: t.lastSync ?? null,
    });
    const findToken = (id) => cfg.tokens.find((t) => t.id === id);
    const cleanName = (n) => String(n ?? "").trim().slice(0, 60) || "Upload token";

    if (path === "/api/settings" && method === "GET") {
      return json(res, 200, {
        tokens: cfg.tokens.map(view),
        envToken: !!ingestToken,
        password: { set: hasPassword(), source: cfg.auth?.hash ? "settings" : password ? "railway" : "none", updatedAt: cfg.auth?.updatedAt ?? null },
        prefs: cfg.prefs,
        storage: store.kind,
        open: isOpen(),
        fieldsSeen: (await store.getMeta("fieldsSeen")) || null,
      });
    }
    if (path === "/api/prefs" && method === "PUT") {
      const body = await readJson(req);
      const next = { ...cfg.prefs };
      for (const [k, allowed] of Object.entries(PREFS)) {
        if (!(k in (body || {}))) continue;
        const v = allowed.find((a) => String(a) === String(body[k]));
        if (v !== undefined) next[k] = v;
      }
      cfg.prefs = next;
      await store.setMeta("prefs", next);
      return json(res, 200, { ok: true, prefs: next });
    }
    if (path === "/api/tokens" && method === "POST") {
      const body = await readJson(req);
      if (cfg.tokens.length >= 20) return json(res, 400, { error: "That's plenty of tokens — delete one first" });
      const t = { id: randomUUID(), name: cleanName(body?.name), token: newToken(), createdAt: new Date().toISOString() };
      cfg.tokens.push(t);
      await saveTokens();
      return json(res, 200, { ok: true, ...view(t), token: t.token });
    }
    const tm = path.match(/^\/api\/tokens\/([\w-]+)(\/rotate)?$/);
    if (tm) {
      const t = findToken(tm[1]);
      if (!t) return json(res, 404, { error: "No such token" });
      if (tm[2] && method === "POST") {
        t.token = newToken();
        t.createdAt = new Date().toISOString();
        t.lastUsedAt = null;
        t.lastSync = null;
        await saveTokens();
        return json(res, 200, { ok: true, ...view(t), token: t.token });
      }
      if (!tm[2] && method === "GET") return json(res, 200, { ...view(t), token: t.token });
      if (!tm[2] && method === "PUT") {
        t.name = cleanName((await readJson(req))?.name);
        await saveTokens();
        return json(res, 200, { ok: true, ...view(t) });
      }
      if (!tm[2] && method === "DELETE") {
        cfg.tokens = cfg.tokens.filter((x) => x !== t);
        await saveTokens();
        return json(res, 200, { ok: true });
      }
    }
    if (path === "/api/password" && method === "PUT") {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      if (pwLimit.blocked(ip)) return json(res, 429, { error: "Too many tries. Wait a minute." });
      const body = await readJson(req);
      if (hasPassword() && !checkPassword(body?.current)) {
        pwLimit.fail(ip);
        return json(res, 403, { error: "Current password is wrong" });
      }
      const next = String(body?.next ?? "");
      if (next.length < 8) return json(res, 400, { error: "Use at least 8 characters" });
      await saveAuth({ ...hashPassword(next), epoch: epoch() + 1, updatedAt: new Date().toISOString() });
      // Every other device is signed out; this one gets a fresh cookie.
      res.setHeader("set-cookie", cookie(req, sess.issue(epoch()), TTL_SECONDS));
      return json(res, 200, { ok: true });
    }
    if (path === "/api/sessions/revoke" && method === "POST") {
      await saveAuth({ ...(cfg.auth || {}), epoch: epoch() + 1 });
      res.setHeader("set-cookie", cookie(req, sess.issue(epoch()), TTL_SECONDS));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found" });
  }

  /** Only the page itself, its stylesheet and its scripts — never the server's own files. */
  async function serveStatic(res, path) {
    const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const allowed = rel === "index.html" || /^(css|js)\/[\w.-]+\.(css|js)$/.test(rel);
    const file = normalize(join(root, rel));
    if (!allowed || !file.startsWith(root + sep)) return send(res, 404, "Not found", "text/plain");
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...HEADERS, "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      return res.end(body);
    } catch {
      return send(res, 404, "Not found", "text/plain");
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error("[web]", req.method, req.url, err);
      if (!res.headersSent) json(res, status, { error: status >= 500 ? "Server error" : err.message });
      else res.end();
    });
  });
}

/* ── helpers ───────────────────────────────────────────────────────────── */

/**
 * One-time move to per-source buckets (schema 2). Flat days go to "legacy",
 * where food and sleep are held out of every calculation until reviewed.
 * The two new fitness goals join the daily score.
 */
export async function migrate(store) {
  if ((await store.getMeta("schema")) >= 2) return;
  const { days } = await store.getAll();
  const out = {};
  let moved = 0;
  for (const [k, d] of Object.entries(days)) {
    const bucketed = d && typeof d === "object" && ("manual" in d || "apple" in d || "legacy" in d);
    out[k] = bucketed ? d : migrateDay(d);
    if (!bucketed) moved += 1;
  }
  if (moved) await store.replaceDays(out);
  const goals = await store.getMeta("goals");
  if (goals && Array.isArray(goals.tracked)) {
    for (const id of ["active", "exercise"]) if (!goals.tracked.includes(id)) goals.tracked.push(id);
    await store.setMeta("goals", goals);
  }
  await store.setMeta("schema", 2);
  if (moved) console.log(`[web] Moved ${moved} days to per-source storage; food and sleep from before await review in Settings.`);
}

function cleanGoals(raw) {
  const out = { ...DEFAULT_GOALS };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(DEFAULT_GOALS)) {
    if (k === "tracked") continue;
    if (typeof DEFAULT_GOALS[k] === "string") {
      if (typeof raw[k] === "string" && /^\d{2}:\d{2}$/.test(raw[k])) out[k] = raw[k];
      continue;
    }
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (Array.isArray(raw.tracked)) out.tracked = raw.tracked.filter((id) => GOAL_IDS.includes(id));
  if (out.kcalLow > out.kcalHigh) [out.kcalLow, out.kcalHigh] = [out.kcalHigh, out.kcalLow];
  return out;
}

function bearer(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function cookie(req, value, maxAge) {
  const https = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

function readText(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readText(req);
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Body isn't valid JSON"), { status: 400 });
  }
}

function send(res, status, body, type) {
  res.writeHead(status, { ...HEADERS, "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json");
}
function redirect(res, to) {
  res.writeHead(303, { ...HEADERS, location: to });
  res.end();
}

function loginPage(error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0B0B0D">
<title>Sign in · Ash Health</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Archivo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0B0B0D; color: #F3F3F5;
    font: 400 14px/1.5 "Archivo", ui-sans-serif, system-ui, sans-serif; padding: 16px; }
  form { width: min(380px, 100%); background: #151518; border-radius: 26px; padding: 32px 28px; }
  h1 { font: 800 30px/1 "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.045em; margin: 0 0 24px; }
  h1 span { color: #F2A79C; }
  label { display: block; font-size: 12px; font-weight: 600; color: #94949E; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 13px 14px; border-radius: 14px; border: 1px solid transparent;
    background: #222227; color: #fff; font: inherit; font-size: 15px; outline: 0; }
  input:focus { border-color: #F2A79C; }
  button { margin-top: 16px; width: 100%; padding: 13px; border: 0; border-radius: 999px; background: #F3E96C;
    color: #101012; font: 700 14px "Archivo", sans-serif; cursor: pointer; }
  .err { color: #FF8F86; font-weight: 600; margin: -8px 0 14px; }
</style></head><body>
<form method="post" action="/login">
  <h1>ash<span>/health</span></h1>
  ${error ? `<p class="err">${error}</p>` : ""}
  <label for="pw">Password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form></body></html>`;
}
