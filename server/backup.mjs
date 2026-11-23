/* ──────────────────────────────────────────────────────────────────────────
   Backups ("rollback points") of everything you've logged and chosen.

   When one is taken:
     · every few hours (3 by default, set in Settings) — if anything changed
     · every time the server starts, i.e. before each update touches data
     · before anything that replaces data: erase, import, review, restore
     · whenever you press "Back up now"
   An unchanged log is never stored twice.

   What's in one: every day (food diary, sleep, lifts, Apple Health),
   saved foods, meals, rewards, goals, training plan, achievement
   settings and history, dashboard defaults. What isn't: the password,
   sessions, upload tokens and lookup keys — those are security, not
   data, so a rollback can never lock you out or bring back a token you
   revoked — and the food-lookup caches, which refill themselves.

   Restoring first backs up how things are right now, so any rollback
   can itself be undone.

   Kept: everything from the last 2 days, then the newest of each day for
   30 days, then the newest of each week for 6 months, plus up to 30 you
   made yourself.
   ────────────────────────────────────────────────────────────────────────── */
import { createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const DATA_META = ["goals", "prefs", "trainingPlan", "achievementTiers", "achievementCatalog", "achievementLedger", "lastSync", "fieldsSeen", "schema", "notifySettings", "recipesSeeded"];
export const DATA_ITEMS = ["food", "meal", "reward", "recipe", "combo"];
export const EVERY_HOURS = [0, 1, 3, 6, 12, 24];
export const DEFAULT_EVERY = 3;

const HOUR = 3600_000, DAY = 24 * HOUR;
const CHECK_MS = 10 * 60_000;

/** JSON with object keys sorted, so the same data always hashes the same. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function summarize(p) {
  const keys = Object.keys(p.days || {}).sort();
  let entries = 0, lifts = 0;
  for (const d of Object.values(p.days || {})) {
    entries += d?.manual?.foods?.length || 0;
    if (d?.manual?.lifts?.length) lifts += 1;
  }
  return {
    days: keys.length, from: keys[0] || null, to: keys.at(-1) || null, entries, liftDays: lifts,
    foods: p.items?.food?.length || 0, meals: p.items?.meal?.length || 0, rewards: p.items?.reward?.length || 0,
    recipes: p.items?.recipe?.length || 0,
  };
}

// the example recipes alone don't make a log worth backing up
const isEmpty = (p) => !Object.keys(p.days || {}).length && !DATA_ITEMS.some((k) => p.items?.[k]?.some((x) => !x.example));

/** A backup as an export file: the same shape Settings → Export writes, so Import reads it. */
export function toExport(p, takenAt) {
  return {
    format: "ash-health/backup-1", takenAt,
    days: p.days, goals: p.meta?.goals ?? undefined, plan: p.meta?.trainingPlan ?? null, prefs: p.meta?.prefs ?? undefined,
    library: { foods: p.items?.food || [], meals: p.items?.meal || [], rewards: p.items?.reward || [], recipes: p.items?.recipe || [], combos: p.items?.combo || [] },
    achievements: { tiers: p.meta?.achievementTiers ?? {}, ledger: p.meta?.achievementLedger ?? null },
  };
}

export function createBackups({ store, persistent = true, version = "", now = () => Date.now(), log = console }) {
  let timer = null;

  async function collect() {
    const d = await store.dump();
    const meta = {};
    for (const k of DATA_META) if (d.meta[k] !== undefined && d.meta[k] !== null) meta[k] = d.meta[k];
    const items = {};
    for (const kind of DATA_ITEMS) items[kind] = (d.items[kind] || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { days: d.days, meta, items };
  }

  const settings = async () => ({ everyHours: DEFAULT_EVERY, ...((await store.getMeta("backupSettings")) || {}) });
  const checked = async (at) => store.setMeta("backupState", { checkedAt: new Date(at).toISOString() });

  /**
   * Take a backup. kind: "auto" (schedule) · "boot" (before an update) ·
   * "safety" (before something replaces data) · "manual".
   * Skips an empty log, and a log identical to the newest backup.
   */
  async function take(reason, { kind = "auto" } = {}) {
    const p = await collect();
    if (isEmpty(p)) return { skipped: "empty" };
    const hash = createHash("sha256").update(canonical(p)).digest("hex");
    const latest = (await store.listSnapshots())[0];
    if (latest?.hash === hash) {
      await checked(now());
      return { skipped: "unchanged", latest };
    }
    const at = now();
    const data = gzipSync(JSON.stringify(p));
    const info = {
      id: `bk_${at.toString(36)}${randomBytes(3).toString("hex")}`,
      createdAt: new Date(at).toISOString(), reason, kind, version, hash, bytes: data.length, summary: summarize(p),
    };
    await store.putSnapshot({ ...info, data });
    await checked(at);
    await prune();
    return { snapshot: info };
  }

  async function load(id) {
    const s = await store.getSnapshot(id);
    if (!s) return null;
    return { info: s, payload: JSON.parse(gunzipSync(s.data).toString("utf8")) };
  }

  /** Roll back to a backup — after backing up the present, so this can be undone. */
  async function restore(id) {
    const found = await load(id);
    if (!found) throw Object.assign(new Error("That backup no longer exists"), { status: 404 });
    const when = new Date(found.info.createdAt).toISOString().slice(0, 16).replace("T", " ");
    const before = await take(`Before rolling back to ${when} UTC`, { kind: "safety" });
    await store.restore(found.payload, { metaKeys: DATA_META, itemKinds: DATA_ITEMS });
    return { restored: found.info, undo: before.snapshot || before.latest || null };
  }

  /** Thin out old backups (see the header). */
  async function prune() {
    const list = await store.listSnapshots();
    const t = now();
    const keep = new Set(list.slice(0, 3).map((s) => s.id));
    const days = new Set(), weeks = new Set();
    let manual = 0;
    for (const s of list) {
      const at = Date.parse(s.createdAt);
      const age = t - at;
      if (s.kind === "manual" && manual < 30) { manual += 1; keep.add(s.id); continue; }
      if (age < 2 * DAY) { keep.add(s.id); continue; }
      if (age < 30 * DAY) {
        const day = s.createdAt.slice(0, 10);
        if (!days.has(day)) { days.add(day); keep.add(s.id); }
        continue;
      }
      if (age < 182 * DAY) {
        const week = Math.floor(at / (7 * DAY));
        if (!weeks.has(week)) { weeks.add(week); keep.add(s.id); }
      }
    }
    const drop = list.filter((s) => !keep.has(s.id)).map((s) => s.id);
    if (drop.length) await store.deleteSnapshots(drop);
  }

  /** Called every 10 minutes: takes the scheduled backup once it's due. */
  async function tick() {
    const { everyHours } = await settings();
    if (!everyHours) return null;
    const latest = (await store.listSnapshots())[0];
    const state = (await store.getMeta("backupState")) || {};
    const last = Math.max(latest ? Date.parse(latest.createdAt) : 0, state.checkedAt ? Date.parse(state.checkedAt) : 0);
    if (now() - last < everyHours * HOUR) return null;
    return take(`Every ${everyHours} hour${everyHours === 1 ? "" : "s"}`, { kind: "auto" });
  }

  function start() {
    if (timer) return;
    const run = () => tick().catch((e) => log.error("[backup] scheduled backup failed:", e.message));
    run();
    timer = setInterval(run, CHECK_MS);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  async function status() {
    const list = await store.listSnapshots();
    const { everyHours } = await settings();
    const state = (await store.getMeta("backupState")) || {};
    const latest = list[0] || null;
    const base = Math.max(latest ? Date.parse(latest.createdAt) : 0, state.checkedAt ? Date.parse(state.checkedAt) : 0);
    return {
      persistent, everyHours, choices: EVERY_HOURS,
      lastAt: latest?.createdAt || null, checkedAt: state.checkedAt || null,
      nextAt: everyHours && base ? new Date(base + everyHours * HOUR).toISOString() : null,
      count: list.length, snapshots: list,
    };
  }

  /** A backup that could refill an empty log, if the log is empty. */
  async function recovery() {
    const d = await store.dump();
    const empty = !Object.keys(d.days).length && !DATA_ITEMS.some((k) => d.items[k]?.some((x) => !x.example));
    if (!empty) return null;
    const best = (await store.listSnapshots()).find((s) => s.summary?.days > 0 || s.summary?.foods > 0);
    return best ? { id: best.id, createdAt: best.createdAt, summary: best.summary } : null;
  }

  async function setEvery(everyHours) {
    if (!EVERY_HOURS.includes(everyHours)) throw Object.assign(new Error("Pick one of the listed schedules"), { status: 400 });
    await store.setMeta("backupSettings", { everyHours });
    return status();
  }

  return { take, load, restore, prune, tick, start, stop, status, recovery, setEvery, collect };
}
