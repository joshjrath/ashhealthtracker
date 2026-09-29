/* ──────────────────────────────────────────────────────────────────────────
   Routing, the log dialog, tooltips and chart sizing. Pages are pure
   functions of the context; everything here just decides when to draw.
   ────────────────────────────────────────────────────────────────────────── */
import { keyOf, ago, DEFAULT_GOALS, GOAL_IDS } from "./metrics.js";
import { fetchState, api, readExport, seed } from "./store.js";
import { PAGES, CHARTS, fmtDay, dayDetails } from "./views.js";
import { esc } from "./charts.js";
import { resolveDay } from "./sources.js";

/*
 * state.raw  — days as stored: { manual, apple, legacy } buckets (sample days while demo is on)
 * state.days — the same days resolved by the source rules; what every chart reads
 */
let state = { raw: {}, days: {}, goals: { ...DEFAULT_GOALS }, lastSync: null, prefs: {}, open: false, demo: false };
const resolveAll = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolveDay(v)]));
/* What Settings shows: tokens (masked), where the password comes from, storage. */
let settingsInfo = null;
/* Token values revealed with the eye button, this page load only. */
const revealed = {};

async function refresh() {
  const [s, st] = await Promise.all([fetchState(), api.settings()]);
  const demo = !Object.keys(s.days).length && s.prefs?.showSample !== false;
  const raw = demo ? seed(keyOf(new Date())).days : s.days;
  state = { ...s, demo, raw, days: resolveAll(raw) };
  settingsInfo = st;
  // Saved defaults open the charts; a tab clicked this session wins until the tab closes.
  for (const k of PREF_KEYS) if (!(k in sessionUi) && s.prefs?.[k] !== undefined) ui[k] = s.prefs[k];
}

const UI_KEY = "ash-health-ui";
const PREF_KEYS = ["weightRange", "trendRange", "trendMetric", "sleepN"];
const ui = {
  weightRange: "90", trendMetric: "calories", trendRange: 30, sleepN: 7,
  heatWeek: 0, calMonth: 0, fitWeek: 0, demoHidden: false,
};
let sessionUi = {};
try { sessionUi = JSON.parse(sessionStorage.getItem(UI_KEY) || "{}") || {}; } catch { /* fresh */ }
Object.assign(ui, sessionUi, { heatWeek: 0, calMonth: 0, fitWeek: 0 });
const keepUi = () => {
  sessionUi = { ...ui };
  try { sessionStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* fine */ }
};

const view = document.getElementById("view");
const ctx = () => ({ state, g: state.goals, days: state.days, raw: state.raw, today: keyOf(new Date()), ui, settings: settingsInfo, revealed });

function page() {
  const h = location.hash.replace(/^#\/?/, "");
  return PAGES[h] ? h : "today";
}

/* ── drawing ───────────────────────────────────────────────────────────── */

let lastJourney = 0;

function render() {
  const p = page();
  const c = ctx();
  view.innerHTML = PAGES[p].render(c);
  document.title = `${PAGES[p].title} · Ash Health`;
  document.querySelectorAll("aside [data-page]").forEach((a) => a.classList.toggle("on", a.dataset.page === p));
  mountCharts(c);
  animateJourney();
  syncPill();
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
  export: () => {
    if (state.demo) { alert("Nothing to export yet — these are sample days."); return false; }
    const doc = { days: state.raw, goals: state.goals, exportedAt: new Date().toISOString(), format: "ash-health/2 (per-source buckets)" };
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
  state.days[key] = resolveDay(state.raw[key]);
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
  setDay(key, m);
  dlg.close();
  commit(() => api.putDay(key, m));
});

document.getElementById("logdelete").addEventListener("click", () => {
  const key = form.elements.date.value;
  const manual = state.raw[key]?.manual;
  if (state.demo || !manual || !Object.keys(manual).length) return;
  if (!confirm(`Clear everything you logged for ${fmtDay(key)}? Apple Health's steps and workouts for that day stay.`)) return;
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

/* ── settings forms ────────────────────────────────────────────────────── */

const FORMS = {
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
    commit(() => api.putGoals(next)).then(() => flash("#sec-goals", "Saved"));
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
  if (document.visibilityState !== "visible" || dlg.open) return;
  try { await refresh(); render(); } catch { /* keep what's on screen */ }
});
