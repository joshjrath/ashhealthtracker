/* ──────────────────────────────────────────────────────────────────────────
   Routing, the log dialog, tooltips and chart sizing. Pages are pure
   functions of the context; everything here just decides when to draw.
   ────────────────────────────────────────────────────────────────────────── */
import { keyOf, DEFAULT_GOALS, GOAL_IDS } from "./metrics.js";
import { load, save, blank, fromImport } from "./store.js";
import { PAGES, CHARTS, fmtDay } from "./views.js";
import { esc } from "./charts.js";

let state = load();
save(state);

const UI_KEY = "ash-health-ui";
const ui = {
  weightRange: "90", trendMetric: "calories", trendRange: 30, sleepN: 7,
  heatWeek: 0, calMonth: 0, demoHidden: false,
};
try { Object.assign(ui, JSON.parse(sessionStorage.getItem(UI_KEY) || "{}"), { heatWeek: 0, calMonth: 0 }); } catch { /* fresh */ }
const keepUi = () => { try { sessionStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* fine */ } };

const view = document.getElementById("view");
const ctx = () => ({ state, g: state.goals, days: state.days, today: keyOf(new Date()), ui });

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
  document.querySelectorAll("aside nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === p));
  mountCharts(c);
  animateJourney();
  bindSettings();
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

function commit() {
  save(state);
  render();
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
  log: (el) => openLog(el.dataset.key || keyOf(new Date())),
  "weight-range": (el) => { ui.weightRange = el.dataset.v; },
  "trend-range": (el) => { ui.trendRange = Number(el.dataset.v); },
  "trend-metric": (el) => { ui.trendMetric = el.dataset.v; },
  "sleep-n": (el) => { ui.sleepN = Number(el.dataset.v); },
  heat: (el) => { const v = Number(el.dataset.v); ui.heatWeek = v === 0 ? 0 : Math.min(0, ui.heatWeek + v); },
  cal: (el) => { const v = Number(el.dataset.v); ui.calMonth = v === 0 ? 0 : Math.min(0, ui.calMonth + v); },
  "demo-hide": () => { ui.demoHidden = true; },
  "demo-clear": () => {
    if (!confirm("Clear the sample days and start an empty log? Your goals stay.")) return false;
    state = blank(state.goals);
    save(state);
  },
  reset: () => {
    if (!confirm("Erase every logged day in this browser? Export first if you want a copy.")) return false;
    state = blank(state.goals);
    save(state);
  },
  export: () => {
    const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
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
  if (fn(el) === false || el.dataset.act === "log") return;
  keepUi();
  render();
});

addEventListener("hashchange", () => { render(); scrollTo(0, 0); });

/* ── the log dialog ────────────────────────────────────────────────────── */

const dlg = document.getElementById("log");
const form = document.getElementById("logform");
const NUMS = ["weight", "kcal", "protein", "carbs", "fat", "fiber", "steps"];

function openLog(key) {
  const d = state.days[key] || {};
  form.reset();
  form.elements.date.value = key;
  form.elements.date.max = keyOf(new Date());
  fillLog(d);
  dlg.showModal();
}

function fillLog(d) {
  for (const n of NUMS) form.elements[n].value = d[n] ?? "";
  form.elements.bed.value = d.bed ?? "";
  form.elements.wake.value = d.wake ?? "";
  form.elements.workout.checked = !!d.workout;
  form.elements.creatine.checked = !!d.creatine;
  dlg.querySelector(".dlg-day").textContent = fmtDay(form.elements.date.value);
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
  if (form.elements.date.value) fillLog(state.days[form.elements.date.value] || {});
});
dlg.addEventListener("click", (e) => {
  if (e.target.id === "usemacros") {
    const v = (n) => Number(form.elements[n].value) || 0;
    form.elements.kcal.value = v("protein") * 4 + v("carbs") * 4 + v("fat") * 9;
  }
  if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const key = form.elements.date.value;
  if (!key) return;
  const d = {};
  for (const n of NUMS) {
    const raw = form.elements[n].value.trim();
    if (raw !== "") d[n] = n === "weight" ? Math.round(Number(raw) * 10) / 10 : Math.round(Number(raw));
  }
  if (form.elements.bed.value && form.elements.wake.value) {
    d.bed = form.elements.bed.value;
    d.wake = form.elements.wake.value;
  }
  d.workout = form.elements.workout.checked;
  d.creatine = form.elements.creatine.checked;
  state.days[key] = d;
  dlg.close();
  commit();
});

document.getElementById("logdelete").addEventListener("click", () => {
  const key = form.elements.date.value;
  if (!state.days[key] || !confirm(`Remove everything logged for ${fmtDay(key)}?`)) return;
  delete state.days[key];
  dlg.close();
  commit();
});

/* ── settings ──────────────────────────────────────────────────────────── */

function bindSettings() {
  const gf = document.getElementById("goalsform");
  if (gf) {
    gf.addEventListener("submit", (e) => {
      e.preventDefault();
      const next = { ...state.goals };
      for (const k of Object.keys(DEFAULT_GOALS)) {
        if (k === "tracked") continue;
        const v = Number(gf.elements[k].value);
        if (Number.isFinite(v)) next[k] = v;
      }
      if (next.kcalLow > next.kcalHigh) [next.kcalLow, next.kcalHigh] = [next.kcalHigh, next.kcalLow];
      next.tracked = [...gf.querySelectorAll("input[name=tracked]:checked")].map((i) => i.value).filter((id) => GOAL_IDS.includes(id));
      state.goals = next;
      commit();
      const m = document.getElementById("savedmsg");
      if (m) m.hidden = false;
    });
  }
  const file = document.getElementById("importfile");
  if (file) {
    file.addEventListener("change", async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const next = fromImport(await f.text());
        if (!confirm(`Replace this browser's log with ${Object.keys(next.days).length} imported days?`)) return;
        state = next;
        commit();
      } catch (err) {
        alert(`Couldn't import that file: ${err.message}`);
      }
    });
  }
}

render();
