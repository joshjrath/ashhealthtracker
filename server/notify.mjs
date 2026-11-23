/* ──────────────────────────────────────────────────────────────────────────
   Notifications — one service every feature reports through.

   A feature never shows a notification itself: it calls emit() with what
   happened, and this service decides whether it's worth telling you:

     emit({ type, category, priority, key, fp, title, body, link,
            repeat, cooldownH, minGapH })

     key        what it's about ("wt:plateau", "rem:meal:2026-11-23") —
                one live notification per key; a newer one replaces it
     fp         the meaningful content. Same key + same fp = nothing new,
                so nothing is sent (unless `repeat` and the cooldown passed)
     minGapH    how soon a changed fp may notify again (anti-flap)
     priority   critical · important · info · reminder

   Then, in order: category off → dropped (critical never is) · a reminder
   during quiet hours → not sent (it can fire after) · category set to a
   daily or weekly digest, or past the daily limit → held for the digest ·
   otherwise shown in the bell and pushed to browsers that allowed it
   (pushes wait out quiet hours, except critical ones).

   cancel(match) removes live notifications that no longer apply — a
   "log your meals" reminder disappears the moment a meal is logged.

   Rules that watch your data live in notify-rules.mjs; one-off events
   (a failed sync, a password change) come in through event().
   ────────────────────────────────────────────────────────────────────────── */
import { randomUUID } from "node:crypto";
import { makeVapidKeys, sendPush } from "./webpush.mjs";

export const CATEGORIES = {
  nutrition: "Nutrition",
  weight: "Weight & body",
  fitness: "Training",
  recovery: "Sleep & recovery",
  insights: "Insights & targets",
  achievements: "Achievements & goals",
  phases: "Fitness phases",
  system: "Sync, backups & security",
};
export const MODES = ["on", "daily", "weekly", "off"];
export const PRIORITIES = ["critical", "important", "info", "reminder"];
const HM = /^\d{2}:\d{2}$/;
const H = 3600_000;
const MAX_ITEMS = 300;

export const DEFAULT_NOTIFY = {
  categories: Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, "on"])),
  reminders: {
    meal: { on: false, time: "13:00" },
    weighIn: { on: false, time: "09:00" },
    workout: { on: false, time: "17:00" },
    bedtime: { on: false, before: 30 },
  },
  quiet: { on: true, from: "22:00", to: "07:00" },
  maxPerDay: 6,
  digestTime: "08:00",
  push: true, // send to browsers that allowed it
  timeZone: "",
};

export function cleanNotifySettings(raw, base = DEFAULT_NOTIFY) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = structuredClone(base);
  for (const c of Object.keys(CATEGORIES)) if (MODES.includes(r.categories?.[c])) out.categories[c] = r.categories[c];
  for (const k of Object.keys(DEFAULT_NOTIFY.reminders)) {
    const v = r.reminders?.[k];
    if (!v || typeof v !== "object") continue;
    if (typeof v.on === "boolean") out.reminders[k].on = v.on;
    if (HM.test(v.time || "")) out.reminders[k].time = v.time;
    if ([15, 30, 45, 60].includes(Number(v.before))) out.reminders[k].before = Number(v.before);
  }
  if (r.quiet && typeof r.quiet === "object") {
    if (typeof r.quiet.on === "boolean") out.quiet.on = r.quiet.on;
    if (HM.test(r.quiet.from || "")) out.quiet.from = r.quiet.from;
    if (HM.test(r.quiet.to || "")) out.quiet.to = r.quiet.to;
  }
  if ([3, 6, 10, 99].includes(Number(r.maxPerDay))) out.maxPerDay = Number(r.maxPerDay);
  if (HM.test(r.digestTime || "")) out.digestTime = r.digestTime;
  if (typeof r.push === "boolean") out.push = r.push;
  if (typeof r.timeZone === "string" && r.timeZone.length < 64) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: r.timeZone || undefined }); out.timeZone = r.timeZone; } catch { /* unknown zone: keep */ }
  }
  return out;
}

export const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };

/** Your local date, minutes past midnight and weekday (0 = Sunday), in your time zone. */
export function localNow(timeZone, at = Date.now()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const key = `${p.year}-${p.month}-${p.day}`;
  return { key, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: new Date(`${key}T12:00:00Z`).getUTCDay() };
}

export function inQuiet(s, minutes) {
  if (!s.quiet?.on) return false;
  const a = hm(s.quiet.from), b = hm(s.quiet.to);
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/**
 * createNotifier({ store, now, log, fetchImpl, subject })
 * The store keeps three things in meta: "notifications" (items + what's been
 * seen), "notifySettings", and "push" (VAPID keys and browser subscriptions —
 * never in backups or exports).
 */
export function createNotifier({ store, now = () => Date.now(), log = console, fetchImpl, subject = "mailto:ash-health@localhost" }) {
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  const loadState = async () => ({ items: [], seen: {}, primed: false, digests: {}, ...((await store.getMeta("notifications")) || {}) });
  const saveState = (s) => store.setMeta("notifications", s);
  const settings = async () => cleanNotifySettings(await store.getMeta("notifySettings"));
  async function saveSettings(raw) {
    const next = cleanNotifySettings(raw, await settings());
    await store.setMeta("notifySettings", next);
    return next;
  }

  /* ── push ── */
  async function pushState() {
    const p = (await store.getMeta("push")) || {};
    if (!p.vapid) { p.vapid = makeVapidKeys(); p.subs = p.subs || []; await store.setMeta("push", p); }
    return { subs: [], ...p };
  }
  async function deliver(item, { force = false } = {}) {
    const s = await settings();
    if (!s.push && !force) return { sent: 0 };
    const p = await pushState();
    if (!p.subs.length) return { sent: 0 };
    let sent = 0, changed = false;
    const payload = { title: item.title, body: item.body, link: item.link || "/", tag: item.key, priority: item.priority };
    for (const sub of p.subs) {
      let attempt = 0, res = null;
      while (attempt < 2) {
        try { res = await sendPush(sub, payload, { vapid: p.vapid, subject, urgency: item.priority === "critical" ? "high" : "normal", ...(fetchImpl ? { fetchImpl } : {}) }); } catch (e) { res = { ok: false, status: 0, error: e.message }; }
        if (res.ok || res.gone || (res.status >= 400 && res.status < 500)) break;
        attempt += 1; // one retry on a network or 5xx failure
      }
      if (res.ok) { sent += 1; sub.lastOk = new Date(now()).toISOString(); sub.failures = 0; changed = true; }
      else if (res.gone) { sub.gone = true; changed = true; }
      else { sub.failures = (sub.failures || 0) + 1; sub.lastError = res.error || `HTTP ${res.status}`; changed = true; log.error?.("[notify] push failed:", sub.lastError); }
    }
    if (changed) { p.subs = p.subs.filter((x) => !x.gone && (x.failures || 0) < 10); await store.setMeta("push", p); }
    return { sent };
  }

  /* ── emit / cancel ── */
  async function emit(n, { prime = false } = {}) {
    return serial(async () => {
      const s = await settings();
      const at = now();
      const local = localNow(s.timeZone, at);
      const mode = n.priority === "critical" ? "on" : s.categories[n.category] || "on";
      if (mode === "off") return null;
      const st = await loadState();
      const prev = st.seen[n.key];
      const fp = String(n.fp ?? "1");
      if (prev && prev.fp === fp && (!n.repeat || at - prev.at < (n.cooldownH ?? 24) * H)) return null;
      if (prev && prev.fp !== fp && at - prev.at < (n.minGapH ?? 0) * H) return null;
      if (prime) { st.seen[n.key] = { fp, at }; await saveState(st); return null; }
      if (n.priority === "reminder" && inQuiet(s, local.minutes)) return null;
      const today = st.items.filter((i) => i.day === local.key && !i.held && i.priority !== "critical" && i.priority !== "reminder" && !i.digest).length;
      let held = mode === "daily" || mode === "weekly" ? mode : null;
      if (!held && n.priority !== "critical" && n.priority !== "reminder" && today >= s.maxPerDay) held = "daily";
      const old = st.items.find((i) => i.key === n.key && !i.dismissedAt);
      const item = {
        id: old && !old.readAt ? old.id : randomUUID(), type: n.type, category: n.category, priority: n.priority,
        key: n.key, fp, title: String(n.title).slice(0, 140), body: String(n.body || "").slice(0, 600), link: n.link || null,
        createdAt: new Date(at).toISOString(), day: local.key, held, readAt: null, dismissedAt: null,
      };
      st.items = st.items.filter((i) => !(i.key === n.key && !i.dismissedAt));
      st.items.unshift(item);
      st.seen[n.key] = { fp, at };
      trim(st);
      await saveState(st);
      if (!held && (n.priority === "critical" || !inQuiet(s, local.minutes))) item.pushed = (await deliver(item)).sent > 0;
      else if (!held) item.pushLater = true;
      if (item.pushed || item.pushLater) await saveState(st);
      return item;
    });
  }

  function trim(st) {
    if (st.items.length <= MAX_ITEMS) return;
    const keep = st.items.filter((i) => !i.dismissedAt && !i.readAt);
    const rest = st.items.filter((i) => i.dismissedAt || i.readAt);
    st.items = [...keep, ...rest].slice(0, MAX_ITEMS).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Remove live notifications that no longer apply. `match`: a key, a key prefix ending in "*", or a function. */
  async function cancel(match) {
    return serial(async () => {
      const st = await loadState();
      const hit = typeof match === "function" ? match : String(match).endsWith("*") ? (i) => i.key.startsWith(String(match).slice(0, -1)) : (i) => i.key === match;
      const before = st.items.length;
      st.items = st.items.filter((i) => i.dismissedAt || !hit(i));
      if (st.items.length !== before) await saveState(st);
      return before - st.items.length;
    });
  }

  /** Daily and weekly digests: one summary of what was held back. Also sends pushes that waited out quiet hours. */
  async function digest() {
    const s = await settings();
    const local = localNow(s.timeZone, now());
    const out = [];
    if (local.minutes < hm(s.digestTime) || inQuiet(s, local.minutes)) return out;
    const waiting = await serial(async () => {
      const st = await loadState();
      const list = st.items.filter((i) => i.pushLater && !i.dismissedAt && !i.readAt);
      for (const i of list) delete i.pushLater;
      if (list.length) await saveState(st);
      return list;
    });
    for (const i of waiting) await deliver(i);
    for (const kind of ["daily", "weekly"]) {
      if (kind === "weekly" && local.weekday !== 1) continue;
      const made = await serial(async () => {
        const st = await loadState();
        if (st.digests[kind] === local.key) return null;
        const held = st.items.filter((i) => i.held === kind && !i.dismissedAt);
        st.digests[kind] = local.key;
        if (!held.length) { await saveState(st); return null; }
        for (const i of held) { i.held = null; i.digest = true; }
        const item = {
          id: randomUUID(), type: `digest.${kind}`, category: "insights", priority: "info", key: `digest:${kind}:${local.key}`, fp: String(held.length),
          title: `${kind === "daily" ? "Daily" : "Weekly"} digest: ${held.length} update${held.length === 1 ? "" : "s"}`,
          body: held.slice(0, 6).map((i) => `• ${i.title}`).join("\n"), link: "#/notifications",
          createdAt: new Date(now()).toISOString(), day: local.key, held: null, readAt: null, dismissedAt: null,
        };
        st.items.unshift(item);
        trim(st);
        await saveState(st);
        return item;
      });
      if (made) { await deliver(made); out.push(made); }
    }
    return out;
  }

  /* ── what the bell shows ── */
  async function list() {
    const st = await loadState();
    const items = st.items.filter((i) => !i.dismissedAt && !i.held);
    return { items, unread: items.filter((i) => !i.readAt).length, held: st.items.filter((i) => i.held && !i.dismissedAt).length };
  }
  const mark = (field) => (ids) => serial(async () => {
    const st = await loadState();
    const stamp = new Date(now()).toISOString();
    for (const i of st.items) {
      if (i[field]) continue;
      if (ids === "all" || (ids === "read" && i.readAt) || (Array.isArray(ids) && ids.includes(i.id))) {
        i[field] = stamp;
        if (field === "dismissedAt" && !i.readAt) i.readAt = stamp;
      }
    }
    await saveState(st);
  });

  /* ── one-off events from the rest of the server ── */
  const EVENTS = {
    "ingest-failed": (d) => ({ type: "sync.failed", category: "system", priority: "important", key: "sys:ingest", fp: d.message, minGapH: 6, title: "An Apple Health upload was refused", body: `${d.message}. Nothing was saved from it — check the app's settings in Settings → Apple Health.`, link: "#/settings" }),
    "backup-failed": (d) => ({ type: "backup.failed", category: "system", priority: "critical", key: "sys:backup", fp: d.message, minGapH: 12, title: "A scheduled backup failed", body: `${d.message}. Your data is untouched; the next check retries. If it keeps failing, download a backup from Settings → Backups.`, link: "#/settings" }),
    "login-burst": (d) => ({ type: "security.login", category: "system", priority: "critical", key: "sec:login", fp: d.hour, title: "Several wrong passwords in a row", body: `Sign-in was paused after repeated wrong passwords${d.ip ? ` from ${d.ip}` : ""}. If that wasn't you, change your password in Settings → Sign-in & security.`, link: "#/settings" }),
    "password-changed": () => ({ type: "security.password", category: "system", priority: "important", key: "sec:pw", fp: String(now()), title: "Your password was changed", body: "Other devices were signed out. If this wasn't you, set a new password with PASSWORD_RESET in Railway.", link: "#/settings" }),
    "sessions-revoked": () => ({ type: "security.sessions", category: "system", priority: "important", key: "sec:sessions", fp: String(now()), title: "Every other device was signed out", body: "Done from Settings → Sign-in & security.", link: "#/settings" }),
    "token-created": (d) => ({ type: "security.token", category: "system", priority: "info", key: `sec:token:${d.id}`, fp: "created", title: `Upload token “${d.name}” created`, body: "It can send Apple Health data here, nothing else.", link: "#/settings" }),
    "token-deleted": (d) => ({ type: "security.token", category: "system", priority: "info", key: `sec:token:${d.id}`, fp: "deleted", title: `Upload token “${d.name}” deleted`, body: "Anything still using it will be refused.", link: "#/settings" }),
    "backup-link-created": (d) => ({ type: "security.link", category: "system", priority: "important", key: `sec:link:${d.id}`, fp: "created", title: "A backup link was created", body: `“${d.name}” can download your whole log. Delete it in Settings → Backups if you didn't make it.`, link: "#/settings" }),
    "restored": (d) => ({ type: "data.restored", category: "system", priority: "important", key: "data:restore", fp: String(now()), title: `Your log was replaced from ${d.from}`, body: `${d.days} days put back. What was there before was backed up first — undo it in Settings → Backups.`, link: "#/settings" }),
  };
  async function event(name, data = {}) {
    const make = EVENTS[name];
    if (!make) return null;
    try { return await emit(make(data)); } catch (e) { log.error?.("[notify] event failed:", e.message); return null; }
  }

  async function subscribe(sub, ua) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error("That isn't a push subscription"), { status: 400 });
    const p = await pushState();
    p.subs = p.subs.filter((x) => x.endpoint !== sub.endpoint);
    p.subs.push({ id: randomUUID(), endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: String(ua || "").slice(0, 120), createdAt: new Date(now()).toISOString() });
    await store.setMeta("push", p);
    return p.subs.length;
  }
  async function unsubscribe(endpoint) {
    const p = await pushState();
    p.subs = p.subs.filter((x) => (endpoint ? x.endpoint !== endpoint : false));
    await store.setMeta("push", p);
  }
  async function pushInfo() {
    const p = await pushState();
    return { publicKey: p.vapid.publicKey, devices: p.subs.map((x) => ({ id: x.id, ua: x.ua, createdAt: x.createdAt, lastOk: x.lastOk || null, lastError: x.lastError || null })) };
  }
  async function test() {
    return deliver({ title: "Ash Health test notification", body: "If you can see this, browser notifications work on this device.", link: "#/settings", key: "test", priority: "info" }, { force: true });
  }

  return { emit, cancel, digest, list, read: mark("readAt"), dismiss: mark("dismissedAt"), event, settings, saveSettings, subscribe, unsubscribe, pushInfo, test, loadState, saveState, serial };
}
