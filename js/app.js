/* ──────────────────────────────────────────────────────────────────────────
   Routing, the log dialog, tooltips and chart sizing. Pages are pure
   functions of the context; everything here just decides when to draw.

   Achievements are evaluated once per draw from the same resolved days
   every chart reads, and that one result feeds Today's Next Unlock, the
   trophy room, the sidebar count, rewards and the unlock moment.
   ────────────────────────────────────────────────────────────────────────── */
import { keyOf, ago, addDays, DEFAULT_GOALS, GOAL_IDS } from "./metrics.js";
import { fetchState, api, readExport, seed, DEMO_PLAN } from "./store.js";
import { PAGES, CHARTS, fmtDay, dayDetails, foodDay } from "./views.js";
import { esc } from "./charts.js";
import { resolveDay, cleanLift } from "./sources.js";
import { evaluate, buildCatalog, unseenUnlocks, DEFAULT_CATALOG } from "./achievements.js";
import { badgeDetail, nextPanel, rewardForm, celebration } from "./trophies.js";
import { liftForm } from "./strength.js";
import { cleanPlan, WEEKDAYS } from "./training.js";
import { cleanMeal, cleanReward, cleanFood, newId } from "./library.js";
import { dayLabel } from "./diary.js";
import { initFoodSheet, openAdd, openEntry, openLogFood, openFood, openMeal, openMealLog, closeSheet } from "./foodsheet.js";

/*
 * state.raw  — days as stored: { manual, apple, legacy } buckets (sample days while demo is on)
 * state.days — the same days resolved by the source rules; what every chart reads
 * state.library — saved foods, meals and rewards (sample foods join while demo is on)
 * state.achievements — tier overrides, extra families, and the ledger of celebrated unlocks
 */
let state = {
  raw: {}, days: {}, goals: { ...DEFAULT_GOALS }, lastSync: null, prefs: {}, open: false, demo: false,
  library: { foods: [], meals: [], rewards: [] }, plan: null, savedPlan: null,
  achievements: { tiers: {}, catalog: [], ledger: { initializedAt: null, entries: {} } }, lookup: {},
};
const resolveAll = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolveDay(v, k)]));
/* What Settings shows: tokens (masked), where the password comes from, storage. */
let settingsInfo = null;
/* Token values revealed with the eye button, this page load only. */
const revealed = {};

async function refresh() {
  const [s, st] = await Promise.all([fetchState(), api.settings()]);
  const demo = !Object.keys(s.days).length && s.prefs?.showSample !== false;
  const sample = demo ? seed(keyOf(new Date())) : null;
  const raw = demo ? sample.days : s.days;
  const lib = s.library || { foods: [], meals: [], rewards: [] };
  const plan = s.plan || (demo ? DEMO_PLAN : null);
  state = {
    ...s, demo, raw, days: resolveAll(raw),
    goals: { ...s.goals, plan }, plan, savedPlan: s.plan || null,
    library: demo ? { foods: [...lib.foods, ...sample.library.foods], meals: [...lib.meals, ...sample.library.meals], rewards: lib.rewards } : lib,
    serverLibrary: lib,
    achievements: s.achievements || { tiers: {}, catalog: [], ledger: { initializedAt: null, entries: {} } },
  };
  if (demo) state.achievements = { ...state.achievements, ledger: null }; // a sample ledger is made on first draw
  settingsInfo = st;
  // Saved defaults open the charts; a tab clicked this session wins until the tab closes.
  for (const k of PREF_KEYS) if (!(k in sessionUi) && s.prefs?.[k] !== undefined) ui[k] = s.prefs[k];
}

const UI_KEY = "ash-health-ui";
const PREF_KEYS = ["weightRange", "trendRange", "trendMetric", "sleepN"];
const ui = {
  weightRange: "90", trendMetric: "calories", trendRange: 30, sleepN: 7,
  heatWeek: 0, calMonth: 0, fitWeek: 0, demoHidden: false, foodDay: null, libTab: "recent", histDays: 14, sheetTab: "recent",
};
let sessionUi = {};
try { sessionUi = JSON.parse(sessionStorage.getItem(UI_KEY) || "{}") || {}; } catch { /* fresh */ }
Object.assign(ui, sessionUi, { heatWeek: 0, calMonth: 0, fitWeek: 0, foodDay: null, histDays: 14 });
const keepUi = () => {
  sessionUi = { ...ui };
  try { sessionStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* fine */ }
};

const view = document.getElementById("view");
/* The achievements result for the current draw, and badges first seen on this trophy-room visit. */
let ach = null;
let fresh = new Set();
const ctx = () => ({ state, g: state.goals, days: state.days, raw: state.raw, today: keyOf(new Date()), ui, settings: settingsInfo, revealed, ach: ach || evaluateAll(), fresh });

function evaluateAll() {
  const a = state.achievements || {};
  ach = evaluate({
    days: state.days, g: state.goals, today: keyOf(new Date()),
    catalog: buildCatalog(a.catalog, a.tiers), rewards: state.library?.rewards || [],
  });
  return ach;
}

function page() {
  const h = location.hash.replace(/^#\/?/, "");
  return PAGES[h] ? h : "today";
}

/* ── drawing ───────────────────────────────────────────────────────────── */

let lastJourney = 0;

function render() {
  const p = page();
  evaluateAll();
  const ledger = ledgerNow();
  const unseen = unseenUnlocks(ach, ledger);
  if (p === "achievements") {
    // Visiting the trophy room is seeing them: mark them new here, and celebrated.
    for (const t of unseen) fresh.add(t.id);
    if (unseen.length) ackUnlocks(unseen.map((t) => t.id));
  } else fresh = new Set();
  const c = ctx();
  view.innerHTML = PAGES[p].render(c);
  document.title = `${PAGES[p].title} · Ash Health`;
  document.querySelectorAll("aside [data-page]").forEach((a) => a.classList.toggle("on", a.dataset.page === p));
  mountCharts(c);
  animateJourney();
  syncPill();
  syncAchievements(p === "achievements" ? [] : unseenUnlocks(ach, ledgerNow()));
  if (panel) refreshPanel();
}

/* ── achievements: the ledger, the sidebar count, the unlock moment ───── */

let ledgerInitSent = false;
/** The ledger of celebrated unlocks. Sample data gets its own, never saved. */
function ledgerNow() {
  const a = state.achievements;
  if (state.demo) {
    if (!a.ledger) {
      // Show the sample's most recent unlock as new; everything older as already seen.
      const unlocked = ach.tiers.filter((t) => t.unlocked).sort((x, y) => (y.unlockedAt || "").localeCompare(x.unlockedAt || ""));
      a.ledger = { initializedAt: "sample", entries: Object.fromEntries(unlocked.slice(1).map((t) => [t.id, { ackAt: "sample" }])) };
    }
    return a.ledger;
  }
  if (!a.ledger?.initializedAt && !ledgerInitSent && Object.keys(state.raw).length) {
    // First look at achievements: what your history already earned is recorded as historical.
    ledgerInitSent = true;
    const ids = ach.tiers.filter((t) => t.unlocked).map((t) => t.id);
    api.ledger({ init: ids }).then((r) => { state.achievements.ledger = r.ledger; render(); }).catch(() => { ledgerInitSent = false; });
  }
  return a.ledger;
}

function ackUnlocks(ids) {
  const at = new Date().toISOString();
  const l = state.achievements.ledger || (state.achievements.ledger = { initializedAt: at, entries: {} });
  for (const id of ids) l.entries[id] = { ...(l.entries[id] || {}), ackAt: at };
  if (!state.demo) api.ledger({ ack: ids }).catch(() => {});
}

const celebrateEl = document.getElementById("celebrate");
let shownUnlocks = [];
function syncAchievements(unseen) {
  const nav = document.getElementById("achnav");
  if (nav) nav.innerHTML = `${ach.unlockedCount}/${ach.total}${unseen.length ? `<i class="navdot" title="${unseen.length} new"></i><span class="sr-only">, ${unseen.length} new</span>` : ""}`;
  const html = celebration(ctx(), unseen, ledgerNow());
  shownUnlocks = unseen.map((t) => t.id);
  if (celebrateEl.dataset.sig !== shownUnlocks.join(",")) {
    celebrateEl.innerHTML = html;
    celebrateEl.dataset.sig = shownUnlocks.join(",");
  }
  celebrateEl.hidden = !html;
}

/** The rail's status line: when Apple Health last reached the server. */
function syncPill() {
  const el = document.getElementById("syncpill");
  if (!el) return;
  const at = state.lastSync?.at ? new Date(state.lastSync.at) : null;
  el.querySelector("span:last-child").textContent = at ? `Apple Health · ${ago(at)}` : "Apple Health not synced yet";
  el.classList.toggle("stale", !at || Date.now() - at > 36 * 3600 * 1000);
}

function mountCharts(c = ctx()) {
  view.querySelectorAll("[data-chart]").forEach((el) => {
    const w = Math.floor(el.clientWidth);
    if (!w) return;
    el.innerHTML = CHARTS[el.dataset.chart](c, w);
    el.dataset.w = w;
  });
}

/** The marker travels from where it last stood, so a new weigh-in visibly moves it. */
function animateJourney() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  view.querySelectorAll(".journey").forEach((j) => {
    const mark = j.querySelector("[data-anim-left]");
    const fill = j.querySelector("[data-anim-w]");
    const to = Number(mark.dataset.animLeft);
    mark.style.left = `${reduce ? to : lastJourney}%`;
    fill.style.width = `${reduce ? to : lastJourney}%`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      mark.style.left = `${to}%`;
      fill.style.width = `${to}%`;
    }));
    lastJourney = to;
  });
}

let rz;
new ResizeObserver(() => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    const stale = [...view.querySelectorAll("[data-chart]")].some((el) => Math.floor(el.clientWidth) !== Number(el.dataset.w));
    if (stale) mountCharts();
  }, 80);
}).observe(view);

/**
 * Draw the change now, send it, and if the server refuses, say so and
 * redraw from what the server actually holds.
 */
async function commit(send) {
  render();
  try {
    await send();
  } catch (err) {
    if (err.message === "Signed out") return;
    alert(`Couldn't save: ${err.message}`);
    await refresh().catch(() => {});
    render();
  }
}

/** A first real save replaces the sample days rather than joining them. */
function leaveDemo() {
  if (!state.demo) return;
  state.demo = false;
  state.raw = {};
  state.days = {};
  // Sample foods leave with the sample days; anything you saved stays.
  const keep = (list) => (list || []).filter((x) => !String(x.id).startsWith("demo_"));
  state.library = { foods: keep(state.library.foods), meals: keep(state.library.meals), rewards: state.library.rewards };
  state.plan = state.savedPlan;
  state.goals = { ...state.goals, plan: state.savedPlan };
  state.achievements.ledger = null;
}

/* ── tooltip ───────────────────────────────────────────────────────────── */

const tipEl = document.getElementById("tip");
function showTip(target, x, y) {
  const lines = target.dataset.tip.split("|");
  tipEl.innerHTML = `<b>${esc(lines[0])}</b>${lines.slice(1).map((l) => `<span>${esc(l)}</span>`).join("")}`;
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 12;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 18;
  tipEl.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
}
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(t, e.clientX, e.clientY);
  else tipEl.hidden = true;
});
document.addEventListener("focusin", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) { const r = t.getBoundingClientRect(); showTip(t, r.left + r.width / 2, r.top); }
});
document.addEventListener("focusout", () => { tipEl.hidden = true; });
addEventListener("scroll", () => { tipEl.hidden = true; }, { passive: true });

/* ── actions ───────────────────────────────────────────────────────────── */

const ACTS = {
  log: (el) => { if (daydlg.open) daydlg.close(); openLog(el.dataset.key || keyOf(new Date())); },
  day: (el) => { openDay(el.dataset.key); return false; },
  fitweek: (el) => { const v = Number(el.dataset.v); ui.fitWeek = v === 0 ? 0 : Math.min(0, ui.fitWeek + v); },
  "review-all": (el) => {
    const on = el.dataset.v === "hand";
    document.querySelectorAll("#sec-review input[name=keep]").forEach((i) => {
      i.checked = on && !!i.closest(".rvrow").querySelector(".srcTag");
    });
    return false;
  },
  "weight-range": (el) => { ui.weightRange = el.dataset.v; },
  "trend-range": (el) => { ui.trendRange = Number(el.dataset.v); },
  "trend-metric": (el) => { ui.trendMetric = el.dataset.v; },
  "sleep-n": (el) => { ui.sleepN = Number(el.dataset.v); },
  heat: (el) => { const v = Number(el.dataset.v); ui.heatWeek = v === 0 ? 0 : Math.min(0, ui.heatWeek + v); },
  cal: (el) => { const v = Number(el.dataset.v); ui.calMonth = v === 0 ? 0 : Math.min(0, ui.calMonth + v); },
  "demo-hide": () => { ui.demoHidden = true; },
  "copy-text": (el) => { copy(el.dataset.v, el); return false; },
  "demo-clear": () => {
    leaveDemo();
    state.prefs = { ...state.prefs, showSample: false };
    api.putPrefs({ showSample: false }).catch(failed);
  },
  jump: (el) => {
    document.getElementById(el.dataset.v)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return false;
  },
  "set-pref": async (el) => {
    const k = el.dataset.k;
    let v = el.dataset.v;
    if (k === "trendRange" || k === "sleepN") v = Number(v);
    if (k === "showSample") v = v === "true";
    state.prefs = { ...state.prefs, [k]: v };
    if (PREF_KEYS.includes(k)) { ui[k] = v; keepUi(); }
    render();
    try {
      await api.putPrefs({ [k]: v });
      if (k === "showSample") { await refresh(); render(); }
    } catch (err) { failed(err); }
  },
  "token-reveal": async (el) => {
    const id = el.dataset.v;
    if (revealed[id]) delete revealed[id];
    else revealed[id] = (await api.revealToken(id).catch(failed))?.token;
    render();
  },
  "token-copy": async (el) => {
    const id = el.dataset.v;
    const token = revealed[id] || (await api.revealToken(id).catch(failed))?.token;
    if (token) copy(token, el);
  },
  "token-rename": async (el) => {
    const t = settingsInfo?.tokens.find((x) => x.id === el.dataset.v);
    const name = prompt("Name this token", t?.name || "");
    if (name === null) return;
    await api.renameToken(el.dataset.v, name).catch(failed);
    await reload();
  },
  "token-rotate": async (el) => {
    const t = settingsInfo?.tokens.find((x) => x.id === el.dataset.v);
    if (!confirm(`Replace “${t?.name}” with a new value? Whatever uses the old one stops syncing until you paste the new one in.`)) return;
    const r = await api.rotateToken(el.dataset.v).catch(failed);
    if (r) revealed[r.id] = r.token;
    await reload();
  },
  "token-delete": async (el) => {
    const t = settingsInfo?.tokens.find((x) => x.id === el.dataset.v);
    if (!confirm(`Delete “${t?.name}”? Whatever uses it stops syncing.`)) return;
    await api.deleteToken(el.dataset.v).catch(failed);
    delete revealed[el.dataset.v];
    await reload();
  },
  "revoke-sessions": async () => {
    if (!confirm("Sign out every other browser and device? This one stays signed in.")) return;
    if (await api.revokeSessions().catch(failed)) alert("Done — every other device is signed out.");
  },
  reset: () => {
    if (!confirm("Erase every logged day, including Apple Health's? Export first if you want a copy.")) return false;
    state.raw = {};
    state.days = {};
    commit(() => api.eraseDays());
    return false;
  },
  /* food diary */
  "food-day": (el) => {
    const v = Number(el.dataset.v);
    const today = keyOf(new Date());
    const next = v === 0 ? today : addDays(foodDay(ctx()), v);
    ui.foodDay = next >= today ? null : next;
  },
  "food-add": (el) => { openAdd(el.dataset.key || foodDay(ctx()), el.dataset.meal); return false; },
  "food-edit": (el) => { openEntry(el.dataset.key, el.dataset.id); return false; },
  "food-done": (el) => { markFoodDone(el.dataset.key, el.dataset.v === "1"); return false; },
  "food-open": (el) => {
    if (daydlg.open) daydlg.close();
    const k = el.dataset.key;
    ui.foodDay = k === keyOf(new Date()) ? null : k;
    keepUi();
    if (page() !== "nutrition") { pendingJump = "diary"; location.hash = "#/nutrition"; }
    else { render(); document.getElementById("diary")?.scrollIntoView({ behavior: "smooth", block: "start" }); }
    return false;
  },
  "meal-from": (el) => {
    const items = (state.raw[el.dataset.key]?.manual?.foods || []).filter((e) => e.meal === el.dataset.meal)
      .map(({ meal, time, group, id, ...rest }) => rest);
    openMeal(null, { name: "", items });
    return false;
  },
  "hist-more": () => { ui.histDays = Math.min(56, (ui.histDays || 14) + 14); },
  /* My foods */
  "lib-tab": (el) => { ui.libTab = el.dataset.v; },
  "lib-log": (el) => { openLogFood(foodDay(ctx()), el.dataset.id); return false; },
  "lib-edit": (el) => { openFood(el.dataset.id); return false; },
  "food-new": () => { openFood(null); return false; },
  "lib-fav": (el) => { updateFood(el.dataset.id, (f) => ({ ...f, favorite: !f.favorite })); return false; },
  "lib-archive": (el) => { updateFood(el.dataset.id, (f) => ({ ...f, archived: true })); toast("Archived — past diary entries are unchanged"); return false; },
  "lib-unarchive": () => {
    for (const f of state.library.foods.filter((x) => x.archived)) updateFood(f.id, (x) => ({ ...x, archived: false }));
    for (const m of state.library.meals.filter((x) => x.archived)) updateMeal(m.id, (x) => ({ ...x, archived: false }));
    return false;
  },
  "meal-new": () => { openMeal(null); return false; },
  "meal-edit": (el) => { openMeal(el.dataset.id); return false; },
  "meal-log": (el) => { openMealLog(foodDay(ctx()), el.dataset.id); return false; },
  "meal-fav": (el) => { updateMeal(el.dataset.id, (m) => ({ ...m, favorite: !m.favorite })); return false; },
  "meal-archive": (el) => { updateMeal(el.dataset.id, (m) => ({ ...m, archived: true })); toast("Meal archived"); return false; },
  "meal-dup": (el) => {
    const m = state.library.meals.find((x) => x.id === el.dataset.id);
    if (m) sheetApi.saveMeal(cleanMeal({ ...structuredClone(m), id: newId("meal_"), name: `${m.name} (copy)`, favorite: false, createdAt: undefined }));
    return false;
  },
  /* achievements & rewards */
  "next-open": () => { openPanel({ kind: "next" }); return false; },
  "ach-open": (el) => { openPanel({ kind: "badge", id: el.dataset.id }); return false; },
  "reward-new": (el) => { openPanel({ kind: "reward", ach: el.dataset.ach || null }); return false; },
  "reward-edit": (el) => { openPanel({ kind: "reward", id: el.dataset.id }); return false; },
  "reward-claim": (el) => { updateReward(el.dataset.id, (r) => ({ ...r, claimedAt: new Date().toISOString() })); return false; },
  "reward-unclaim": (el) => { updateReward(el.dataset.id, (r) => ({ ...r, claimedAt: null })); return false; },
  "reward-delete": (el) => {
    const r = state.library.rewards.find((x) => x.id === el.dataset.id);
    if (!r || !confirm(`Delete the reward “${r.name}”?`)) return false;
    state.library.rewards = state.library.rewards.filter((x) => x.id !== r.id);
    closePanel();
    commit(() => api.deleteItem("reward", r.id));
    return false;
  },
  "celebrate-view": (el) => {
    const id = el.dataset.id;
    ackUnlocks(shownUnlocks);
    celebrateEl.hidden = true;
    location.hash = "#/achievements";
    if (id) setTimeout(() => openPanel({ kind: "badge", id }), 0);
    return false;
  },
  "celebrate-dismiss": () => { ackUnlocks(shownUnlocks); celebrateEl.hidden = true; render(); return false; },
  /* lifting */
  "lifts-open": (el) => { openLifts(el.dataset.key || keyOf(new Date())); return false; },
  "lift-add-ex": () => { syncLifts(); liftDraft.lifts.push({ exercise: "", sets: [{ reps: "", weight: "", unit: lastUnit() }] }); refreshPanel(); focusLast("input[name^=ex-]"); return false; },
  "lift-add-set": (el) => {
    syncLifts();
    const l = liftDraft.lifts[Number(el.dataset.i)];
    const prev = l.sets[l.sets.length - 1];
    l.sets.push(prev ? { ...prev } : { reps: "", weight: "", unit: lastUnit() });
    refreshPanel();
    return false;
  },
  "lift-del-set": (el) => { syncLifts(); liftDraft.lifts[Number(el.dataset.i)].sets.splice(Number(el.dataset.j), 1); refreshPanel(); return false; },
  "lift-del-ex": (el) => { syncLifts(); liftDraft.lifts.splice(Number(el.dataset.i), 1); refreshPanel(); return false; },
  "lift-clear": () => {
    if (!confirm(`Clear every lift logged on ${fmtDay(liftDraft.key)}?`)) return false;
    saveLifts([]);
    return false;
  },
  /* settings */
  "plan-clear": async () => {
    if (!confirm("Remove your training plan? Training Consistency badges pause until you set one again.")) return;
    await api.putPlan(null).catch(failed);
    state.savedPlan = null;
    state.plan = state.demo ? DEMO_PLAN : null;
    state.goals = { ...state.goals, plan: state.plan };
    render();
  },
  "foodkey-clear": async (el) => {
    await api.putFoodApis({ [el.dataset.k]: "" }).catch(failed);
    await reload();
    flash("#sec-food", "Removed");
  },
  "food-test": async (el) => {
    const out = document.querySelector(`[data-test="${el.dataset.v}"]`);
    if (out) { out.textContent = "Testing…"; out.className = "testres"; }
    try {
      const r = await api.testFoodApi(el.dataset.v);
      if (out) { out.textContent = r.message; out.className = `testres ${r.ok ? "ok" : "bad"}`; }
    } catch (err) {
      if (out) { out.textContent = err.message; out.className = "testres bad"; }
    }
  },
  "tiers-reset": async () => {
    if (!confirm("Put every tier threshold back to its default?")) return;
    const r = await api.putTiers({}).catch(failed);
    if (!r) return;
    state.achievements.tiers = r.tiers;
    render();
    flash("#sec-achievements", "Back to defaults");
  },
  export: () => {
    if (state.demo) { alert("Nothing to export yet — these are sample days."); return false; }
    const doc = {
      days: state.raw, goals: state.goals, library: state.library, plan: state.savedPlan,
      exportedAt: new Date().toISOString(), format: "ash-health/3 (per-source buckets, food diary, library)",
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ash-health-${keyOf(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return false;
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = ACTS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  const r = fn(el);
  if (r === false || r instanceof Promise || el.dataset.act === "log") return;
  keepUi();
  render();
});

function copy(text, el) {
  const done = () => {
    const before = el.innerHTML;
    el.classList.add("done");
    if (!el.classList.contains("ib")) el.textContent = "Copied";
    el.title = "Copied";
    setTimeout(() => { el.innerHTML = before; el.classList.remove("done"); }, 1400);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => prompt("Copy this:", text));
  else prompt("Copy this:", text);
}

function failed(err) {
  if (err?.message !== "Signed out") alert(err?.message || "Something went wrong");
}

const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

/** Fetch again and redraw — after a settings change the server has the final word. */
async function reload() {
  try { await refresh(); } catch (err) { failed(err); }
  render();
}

let pendingJump = null;
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-jump]");
  if (a) pendingJump = a.dataset.jump;
});
addEventListener("hashchange", async () => {
  scrollTo(0, 0);
  if (panel && paneldlg.open) closePanel();
  closeSheet();
  // Settings shows live status (last sync, token use), so it always fetches fresh.
  if (page() === "settings") await reload();
  else render();
  if (pendingJump) {
    document.getElementById(pendingJump)?.scrollIntoView({ block: "start" });
    pendingJump = null;
  }
});

/* ── the log dialog ────────────────────────────────────────────────────── */

const dlg = document.getElementById("log");
const form = document.getElementById("logform");
const NUMS = ["weight", "kcal", "protein", "carbs", "fat", "fiber", "steps", "activeKcal", "exerciseMin"];
const APPLE_OK = ["weight", "steps", "activeKcal", "exerciseMin"];

/** The dialog edits only what you logged; Apple's value for a field shows as its placeholder. */
function openLog(key) {
  form.reset();
  form.elements.date.value = key;
  form.elements.date.max = keyOf(new Date());
  fillLog(key);
  dlg.showModal();
}

function fillLog(key) {
  const manual = state.raw[key]?.manual || {};
  const resolved = state.days[key] || { src: {} };
  for (const n of NUMS) {
    const el = form.elements[n];
    el.value = manual[n] ?? "";
    const other = APPLE_OK.includes(n) && resolved.src?.[n] && resolved.src[n] !== "manual" ? resolved[n] : null;
    el.placeholder = other != null ? `Apple: ${Number(other).toLocaleString("en-US")}` : "";
  }
  form.elements.bed.value = manual.bed ?? "";
  form.elements.wake.value = manual.wake ?? "";
  form.elements.workout.checked = manual.workout === true;
  form.elements.creatine.checked = manual.creatine === true;
  form.elements.foodDone.checked = manual.foodDone === true;
  const ws = resolved.workouts?.length || 0;
  document.getElementById("workouthint").textContent = ws ? `Apple Health has ${ws} workout${ws === 1 ? "" : "s"} for this day.` : "";
  dlg.querySelector(".dlg-day").textContent = fmtDay(key);
  macroHint();
}

function macroHint() {
  const v = (n) => Number(form.elements[n].value) || 0;
  const k = v("protein") * 4 + v("carbs") * 4 + v("fat") * 9;
  const el = document.getElementById("macrohint");
  el.innerHTML = k ? `Macros add up to <b>${k.toLocaleString("en-US")}</b> kcal <button type="button" class="linkbtn" id="usemacros">use it</button>` : "";
}

form.addEventListener("input", (e) => {
  if (["protein", "carbs", "fat"].includes(e.target.name)) macroHint();
});
form.elements.date.addEventListener("change", () => {
  if (form.elements.date.value) fillLog(form.elements.date.value);
});
dlg.addEventListener("click", (e) => {
  if (e.target.id === "usemacros") {
    const v = (n) => Number(form.elements[n].value) || 0;
    form.elements.kcal.value = v("protein") * 4 + v("carbs") * 4 + v("fat") * 9;
  }
  if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
});

function setDay(key, manual) {
  state.raw[key] = { apple: {}, ...(state.raw[key] || {}), manual };
  state.days[key] = resolveDay(state.raw[key], key);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const key = form.elements.date.value;
  if (!key) return;
  leaveDemo();
  const isToday = key === keyOf(new Date());
  const m = {};
  for (const n of NUMS) {
    const raw = form.elements[n].value.trim();
    if (raw !== "") m[n] = n === "weight" ? Math.round(Number(raw) * 10) / 10 : Math.round(Number(raw));
  }
  const bed = form.elements.bed.value, wake = form.elements.wake.value;
  if (bed && wake) { m.bed = bed; m.wake = wake; }
  // An unticked box on a past day is a "no"; on today it just means "not yet".
  const tick = (name) => (form.elements[name].checked ? true : isToday ? undefined : false);
  for (const name of ["workout", "creatine"]) {
    const v = tick(name);
    if (v !== undefined) m[name] = v;
  }
  if (form.elements.foodDone.checked) m.foodDone = true;
  // The dialog edits the day's totals; its diary entries and lifts stay (the server keeps them too).
  const prev = state.raw[key]?.manual || {};
  if (prev.foods) m.foods = prev.foods;
  if (prev.lifts) m.lifts = prev.lifts;
  setDay(key, m);
  dlg.close();
  const { foods, lifts, ...send } = m;
  commit(() => api.putDay(key, send));
});

document.getElementById("logdelete").addEventListener("click", () => {
  const key = form.elements.date.value;
  const manual = state.raw[key]?.manual;
  if (state.demo || !manual || !Object.keys(manual).length) return;
  if (!confirm(`Clear everything you logged for ${fmtDay(key)} — including its food diary and lifts? Apple Health's steps and workouts for that day stay.`)) return;
  setDay(key, {});
  dlg.close();
  commit(() => api.deleteDay(key));
});

/* ── day details ───────────────────────────────────────────────────────── */

const daydlg = document.getElementById("daydlg");
function openDay(key) {
  daydlg.querySelector(".daybody").innerHTML = dayDetails(ctx(), key);
  daydlg.showModal();
}
daydlg.addEventListener("click", (e) => {
  if (e.target === daydlg || e.target.closest("[data-close]")) daydlg.close();
});

/* ── the food diary and your library ───────────────────────────────────── */

/* Foods to save before the day that uses them, so the server can count the use. */
const pendingFoods = new Map();
function upsert(kind, item) {
  const list = state.library[kind];
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.unshift(item);
}
async function flushFoods() {
  for (const [id, food] of [...pendingFoods]) {
    pendingFoods.delete(id);
    await api.putItem("food", food);
  }
}

const sheetApi = {
  state: () => state,
  ui: () => ui,
  today: () => keyOf(new Date()),
  dayLabel: (k) => dayLabel(k, keyOf(new Date())),
  search: (q) => api.searchFood(q),
  estimate: async (text) => (await api.estimateFood(text)).food,
  toast,
  saveFoodLater(food) { upsert("foods", food); pendingFoods.set(food.id, food); },
  async saveFood(food) {
    upsert("foods", food);
    render();
    try { await api.putItem("food", food); } catch (err) { failed(err); await reload(); }
  },
  /** Add or replace diary entries on a day. */
  async saveEntries(key, entries, { replace = [] } = {}) {
    leaveDemo();
    const manual = { ...(state.raw[key]?.manual || {}) };
    const foods = [...(manual.foods || [])];
    const at = new Date().toISOString();
    for (const e of entries) {
      const i = replace.includes(e.id) ? foods.findIndex((x) => x.id === e.id) : -1;
      if (i >= 0) { foods[i] = e; continue; }
      foods.push(e);
      // Mirror the server's count, so Recent and Frequent update straight away.
      const f = e.foodId && state.library.foods.find((x) => x.id === e.foodId);
      if (f) f.uses = { count: (f.uses?.count || 0) + 1, lastUsedAt: at };
    }
    manual.foods = foods;
    setDay(key, manual);
    render();
    try {
      await flushFoods();
      await api.patchDay(key, { foods });
    } catch (err) {
      failed(err);
      await refresh().catch(() => {});
      render();
    }
  },
  async removeEntry(key, id) {
    leaveDemo();
    const manual = { ...(state.raw[key]?.manual || {}) };
    manual.foods = (manual.foods || []).filter((e) => e.id !== id);
    if (!manual.foods.length) delete manual.foods;
    setDay(key, manual);
    commit(() => api.patchDay(key, { foods: manual.foods || [] }));
  },
  async saveMeal(meal) {
    upsert("meals", meal);
    render();
    try { await flushFoods(); await api.putItem("meal", meal); } catch (err) { failed(err); await reload(); }
  },
  async deleteMeal(id) {
    state.library.meals = state.library.meals.filter((m) => m.id !== id);
    commit(() => api.deleteItem("meal", id));
  },
};
initFoodSheet(sheetApi);

/* Sample foods and meals change on screen only; they're never written to the server. */
const isSample = (id) => String(id).startsWith("demo_");
function updateFood(id, change) {
  const f = state.library.foods.find((x) => x.id === id);
  if (!f) return;
  const next = cleanFood(change(structuredClone(f)));
  next.uses = f.uses;
  upsert("foods", next);
  if (isSample(id)) { render(); return; }
  commit(() => api.putItem("food", next));
}
function updateMeal(id, change) {
  const m = state.library.meals.find((x) => x.id === id);
  if (!m) return;
  const next = cleanMeal(change(structuredClone(m)));
  upsert("meals", next);
  if (isSample(id)) { render(); return; }
  commit(() => api.putItem("meal", next));
}
function updateReward(id, change) {
  const r = state.library.rewards.find((x) => x.id === id);
  if (!r) return;
  const next = cleanReward(change(structuredClone(r)));
  upsert("rewards", next);
  commit(() => api.putItem("reward", next));
}

/** Complete / in progress: the one switch that lets a day count toward averages and badges. */
function markFoodDone(key, done) {
  leaveDemo();
  const manual = { ...(state.raw[key]?.manual || {}) };
  if (done) manual.foodDone = true; else delete manual.foodDone;
  setDay(key, manual);
  commit(() => api.patchDay(key, { foodDone: done ? true : null }));
}

/* ── the panel: badge details, next unlocks, rewards, lifts ────────────── */

const paneldlg = document.getElementById("paneldlg");
const panelBody = paneldlg.querySelector(".panelbody");
let panel = null; // { kind, id?, ach? }

function panelHtml() {
  const c = ctx();
  switch (panel.kind) {
    case "next": return nextPanel(c);
    case "badge": return badgeDetail(c, panel.id);
    case "reward": return rewardForm(c, panel.id ? state.library.rewards.find((r) => r.id === panel.id) : null, panel.ach);
    case "lifts": return liftForm(c, liftDraft);
    default: return "";
  }
}
function openPanel(p) {
  panel = p;
  panelBody.innerHTML = panelHtml();
  paneldlg.classList.toggle("wide", p.kind === "lifts" || p.kind === "next");
  if (!paneldlg.open) paneldlg.showModal();
  const first = panelBody.querySelector("input:not([type=hidden]), select");
  if (first && matchMedia("(pointer: fine)").matches && p.kind !== "badge") first.focus();
}
/** Redraw the open panel (its data changed), keeping the scroll position. */
function refreshPanel() {
  if (!panel || !paneldlg.open) return;
  if (panel.kind === "reward") return; // a form being typed into is left alone
  if (panel.kind === "lifts") syncLifts();
  const top = paneldlg.scrollTop;
  panelBody.innerHTML = panelHtml();
  paneldlg.scrollTop = top;
}
function closePanel() {
  panel = null;
  if (paneldlg.open) paneldlg.close();
}
paneldlg.addEventListener("click", (e) => {
  if (e.target === paneldlg || e.target.closest("[data-close]")) closePanel();
});
paneldlg.addEventListener("close", () => { panel = null; });
paneldlg.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form]");
  if (!f || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  FORMS[f.dataset.form](f);
});

/* ── lifting ───────────────────────────────────────────────────────────── */

let liftDraft = null;
const lastUnit = () => liftDraft?.lifts.flatMap((l) => l.sets).map((x) => x.unit).filter(Boolean).pop() || "lb";
function openLifts(key) {
  const saved = state.raw[key]?.manual?.lifts || [];
  liftDraft = { key, lifts: saved.length ? structuredClone(saved) : [{ exercise: "", sets: [{ reps: "", weight: "", unit: "lb" }] }] };
  openPanel({ kind: "lifts" });
}
/** Read what's typed into the draft before the form redraws. */
function syncLifts() {
  const f = panelBody.querySelector("[data-form=lifts]");
  if (!f || !liftDraft) return;
  liftDraft.lifts.forEach((l, i) => {
    l.exercise = f.elements[`ex-${i}`]?.value ?? l.exercise;
    l.sets.forEach((st, j) => {
      st.reps = f.elements[`r-${i}-${j}`]?.value ?? st.reps;
      st.weight = f.elements[`w-${i}-${j}`]?.value ?? st.weight;
      st.unit = f.elements[`u-${i}-${j}`]?.value ?? st.unit;
    });
  });
}
function focusLast(sel) {
  const list = panelBody.querySelectorAll(sel);
  list[list.length - 1]?.focus();
}
function saveLifts(lifts) {
  const key = liftDraft.key;
  leaveDemo();
  const manual = { ...(state.raw[key]?.manual || {}) };
  if (lifts.length) manual.lifts = lifts; else delete manual.lifts;
  setDay(key, manual);
  closePanel();
  commit(() => api.patchDay(key, { lifts }));
}

/* ── settings forms ────────────────────────────────────────────────────── */

const FORMS = {
  lifts() {
    syncLifts();
    const lifts = liftDraft.lifts.map((l) => cleanLift({ ...l, exercise: l.exercise.trim() })).filter(Boolean);
    const typed = liftDraft.lifts.filter((l) => l.exercise.trim() || l.sets.some((x) => x.reps)).length;
    if (typed > lifts.length && !confirm("Some exercises are missing a name or reps and won't be saved. Save the rest?")) return;
    saveLifts(lifts);
  },
  reward(f) {
    const id = f.dataset.id || newId("rew_");
    const prev = state.library.rewards.find((r) => r.id === id);
    const r = cleanReward({
      ...(prev || {}), id,
      name: f.elements.name.value, achievementId: f.elements.achievementId.value || null,
      requirement: f.elements.requirement.value, description: f.elements.description.value,
    });
    if (!r) return;
    if (!f.elements.requirement.value.trim()) delete r.requirement;
    if (!f.elements.description.value.trim()) delete r.description;
    upsert("rewards", r);
    closePanel();
    commit(() => api.putItem("reward", r));
  },
  async plan(f) {
    const days = Object.fromEntries(WEEKDAYS.map((d) => [d, f.elements[d].value]));
    const plan = cleanPlan({ days, since: f.elements.since.value || null });
    const r = await api.putPlan(plan).catch(failed);
    if (!r) return;
    state.savedPlan = r.plan;
    state.plan = r.plan;
    state.goals = { ...state.goals, plan: r.plan };
    render();
    flash("#sec-training", "Plan saved");
  },
  async foodapis(f) {
    const body = { anthropicModel: f.elements.anthropicModel.value, offEnabled: f.elements.offEnabled.checked };
    for (const k of ["usdaKey", "anthropicKey", "fatsecretId", "fatsecretSecret"]) {
      const v = f.elements[k].value.trim();
      if (v) body[k] = v;
    }
    const r = await api.putFoodApis(body).catch(failed);
    if (!r) return;
    await reload();
    flash("#sec-food", "Saved");
  },
  async tiers(f) {
    const body = {};
    for (const c of DEFAULT_CATALOG) {
      const n = c.tiers.map((_, i) => Number(f.elements[`${c.id}-${i}`].value));
      if (n.some((v, i) => !(v > 0) || (i && v <= n[i - 1]))) {
        const el = f.querySelector("[data-err]");
        el.textContent = `${c.name}: each tier must be larger than the one before.`;
        el.hidden = false;
        return;
      }
      body[c.id] = n;
    }
    f.querySelector("[data-err]").hidden = true;
    const r = await api.putTiers(body).catch(failed);
    if (!r) return;
    state.achievements.tiers = r.tiers;
    render();
    flash("#sec-achievements", "Saved — progress recalculated");
  },
  goals(f) {
    const next = { ...state.goals };
    for (const k of Object.keys(DEFAULT_GOALS)) {
      if (k === "tracked" || !f.elements[k]) continue;
      if (typeof DEFAULT_GOALS[k] === "string") { next[k] = f.elements[k].value || DEFAULT_GOALS[k]; continue; }
      const v = Number(f.elements[k].value);
      if (Number.isFinite(v)) next[k] = v;
    }
    if (next.kcalLow > next.kcalHigh) [next.kcalLow, next.kcalHigh] = [next.kcalHigh, next.kcalLow];
    next.tracked = [...f.querySelectorAll("input[name=tracked]:checked")].map((i) => i.value).filter((id) => GOAL_IDS.includes(id));
    state.goals = next;
    const { plan, ...send } = next;
    commit(() => api.putGoals(send)).then(() => flash("#sec-goals", "Saved"));
  },
  async review(f) {
    const all = [...f.querySelectorAll("input[name=keep]")];
    const keep = all.filter((i) => i.checked).map((i) => i.value);
    const reject = all.filter((i) => !i.checked).map((i) => i.value);
    if (!confirm(`Keep ${keep.length} day${keep.length === 1 ? "" : "s"} as yours and set aside ${reject.length}?`)) return;
    const r = await api.review({ keep, reject }).catch(failed);
    if (!r) return;
    await reload();
    flash("#sec-data", `Done — ${keep.length} kept, ${reject.length} set aside.`);
  },
  async token(f) {
    const name = f.elements.name.value.trim() || "iPhone";
    const r = await api.createToken(name).catch(failed);
    if (!r) return;
    revealed[r.id] = r.token; // shown in full so it can be copied straight away
    await reload();
  },
  async password(f) {
    const next = f.elements.next.value, confirmPw = f.elements.confirm.value;
    const err = (msg) => {
      const el = f.querySelector("[data-err]");
      el.textContent = msg;
      el.hidden = !msg;
    };
    if (next.length < 8) return err("Use at least 8 characters.");
    if (next !== confirmPw) return err("The two new passwords don't match.");
    err("");
    try {
      await api.changePassword(f.elements.current?.value ?? "", next);
    } catch (e) {
      return err(e.message);
    }
    await reload();
    flash("#sec-security", "Password saved. Other devices are signed out.");
  },
};

view.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form]");
  if (!f || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  FORMS[f.dataset.form](f);
});

view.addEventListener("change", async (e) => {
  if (e.target.id !== "importfile") return;
  const file = e.target.files[0];
  if (!file) return;
  try {
    const next = readExport(await file.text());
    if (!confirm(`Replace every stored day with the ${Object.keys(next.days).length} days in this file?`)) return;
    await api.importAll(next);
    await reload();
  } catch (err) {
    alert(`Couldn't import that file: ${err.message}`);
  }
});

function flash(section, msg) {
  const el = document.querySelector(`${section} [data-saved]`);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

try {
  await refresh();
} catch (err) {
  if (err.message !== "Signed out") view.innerHTML = `<div class="banner"><span><b>Couldn't reach the server.</b> ${esc(err.message)}</span></div>`;
}
if (!view.firstElementChild) render();

// Pick up Apple Health syncs that land while the page is open.
document.addEventListener("visibilitychange", async () => {
  // Never redraw under something you're typing into.
  if (document.visibilityState !== "visible" || dlg.open || paneldlg.open || document.getElementById("fooddlg").open) return;
  try { await refresh(); render(); } catch { /* keep what's on screen */ }
});
