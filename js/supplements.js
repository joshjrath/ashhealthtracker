/* ──────────────────────────────────────────────────────────────────────────
   Supplements: what you take, and which you took each day.

   The list lives with your goals (goals.supplements): a name, an optional
   dose, and the dates it applies between. Each day keeps a yes/no per
   supplement, checked off one by one. Creatine keeps its own field
   (manual.creatine) from before there was a list; every other supplement
   is under manual.supps by id.

   The "Supplements" goal is hit when everything due that day was taken.
   A supplement is only due from the day you added it (since) and until
   the day you removed it, so changing the list never rewrites history —
   adding fish oil today can't turn last month's creatine days into misses.

   Shared by the browser and the server.
   ────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_SUPPLEMENTS = [{ id: "creatine", name: "Creatine", dose: "5 g" }];
const ID_RE = /^[a-z0-9_]{1,32}$/;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 40;

/** The list, checked: unique ids, a name, an optional dose and dates. Not an array → the default. */
export function cleanSupplements(raw) {
  if (!Array.isArray(raw)) return DEFAULT_SUPPLEMENTS.map((s) => ({ ...s }));
  const out = [];
  const seen = new Set();
  for (const s of raw.slice(0, MAX)) {
    if (!s || typeof s !== "object") continue;
    const id = typeof s.id === "string" && ID_RE.test(s.id) ? s.id : null;
    const name = typeof s.name === "string" ? s.name.trim().slice(0, 40) : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const x = { id, name };
    const dose = typeof s.dose === "string" ? s.dose.trim().slice(0, 30) : "";
    if (dose) x.dose = dose;
    if (KEY_RE.test(s.since || "")) x.since = s.since;
    if (KEY_RE.test(s.until || "")) x.until = s.until;
    out.push(x);
  }
  return out;
}

/** A day's checkoffs other than creatine: { id: true|false }. */
export function cleanSupps(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [id, v] of Object.entries(raw).slice(0, MAX)) {
    if (id !== "creatine" && ID_RE.test(id) && typeof v === "boolean") out[id] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export const suppLabel = (s) => (s.dose ? `${s.name} · ${s.dose}` : s.name);
/** Still on your list (not removed). */
export const currentSupps = (list) => (list || []).filter((s) => !s.until);
/** Due on day `key`: added on or before it, not removed by it. */
export const dueOn = (list, key) => (list || []).filter((s) => !key || ((!s.since || key >= s.since) && (!s.until || key < s.until)));
/** Shown for day `key` in the log: due that day, or already checked off for it. */
export const shownOn = (list, day, key) => (list || []).filter((s) => dueOn([s], key).length || typeof taken(day, s.id) === "boolean");

/** Taken (true), skipped (false) or not logged (undefined) — from a stored manual bucket or a resolved day. */
export const taken = (day, id) => (id === "creatine" ? day?.creatine : day?.supps?.[id]);

/** The change that records one checkoff, for a PATCH: { creatine } or { supps: { id } }. null clears it. */
export const checkoff = (id, v) => (id === "creatine" ? { creatine: v } : { supps: { [id]: v } });

/** Apply a checkoff to a manual bucket locally (what the server does with the same PATCH). */
export function applyCheckoff(manual, id, v) {
  const m = { ...manual };
  if (id === "creatine") {
    if (typeof v === "boolean") m.creatine = v; else delete m.creatine;
  } else {
    const s = { ...(m.supps || {}) };
    if (typeof v === "boolean") s[id] = v; else delete s[id];
    if (Object.keys(s).length) m.supps = s; else delete m.supps;
  }
  return m;
}

/**
 * The Supplements goal for one day: everything due taken → hit; any
 * marked skipped → miss; some taken and the rest unlogged → still going
 * today, a miss afterwards; nothing logged → no data (or in progress today).
 * An empty list takes the goal out of the day.
 */
export function suppStatus(day, list, isToday) {
  const due = dueOn(list, day?.key);
  if (!due.length) return "off";
  const v = due.map((s) => taken(day, s.id));
  if (v.every((x) => x === true)) return "hit";
  if (v.some((x) => x === false)) return "miss";
  if (v.some((x) => x === true)) return isToday ? "pending" : "miss";
  return isToday ? "pending" : "none";
}

/** "2 of 3 taken" — or null when nothing's due. */
export function suppCount(day, list) {
  const due = dueOn(list, day?.key);
  if (!due.length) return null;
  return { done: due.filter((s) => taken(day, s.id) === true).length, of: due.length, left: due.filter((s) => taken(day, s.id) !== true) };
}

/** A new id for a supplement name, unique within the list. */
export function suppId(name, list) {
  const base = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "supp";
  const ids = new Set((list || []).map((s) => s.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i += 1) if (!ids.has(`${base}_${i}`)) return `${base}_${i}`;
}
