/* ──────────────────────────────────────────────────────────────────────────
   Every panel on the site, each a function of the context:
     ctx = { state, g, days, raw, today, ui, settings, revealed }
   `days` is resolved (sources.js): each value already limited to the
   sources it may come from. Panels return HTML strings. Wide charts leave
   a [data-chart] slot that app.js fills at the slot's measured width.

   Missing is shown as missing: "—", "No data", or "Not enough data yet" —
   never a zero standing in for something that wasn't logged.
   ────────────────────────────────────────────────────────────────────────── */
import {
  METRICS, GOAL_IDS, MIN, addDays, parseKey, range, mondayOf, daysBetween, trackedIds, dayAt,
  goalStatus, dayScore, streak, adherence, valueOf, averageOf, foodStatus, foodCoverage,
  weightSeries, goalProgress, weeklyWeight, weightStats, macroCalories, sleepMinutes, nightOffset,
  workoutsIn, fitnessTotals, workoutStreak, weeklyReview, insights,
  fmtInt, fmt1, fmtK, fmtDur, fmtClock, ago,
} from "./metrics.js";
import { esc, tip, ring, sparkline, weightChart, trendChart, miniBars, sleepTimeline, concentric, workoutWeek, weekBars, shortType, pacingChart } from "./charts.js";
import { reviewItems } from "./sources.js";
import { MEALS } from "./nutrition.js";
import { WEEKDAYS, WEEKDAY_LABELS, PLAN_TYPES, PLAN_LABELS } from "./training.js";
import { DEFAULT_CATALOG } from "./achievements.js";
import { foodDiaryCard, dailySummaryCard, weeklyBudgetCard, foodHistoryCard, libraryCard, pacingRows, macroLine, srcTag } from "./diary.js";
import { nextUnlockCard, achievementsPage } from "./trophies.js";
import { strengthCard, setsText } from "./strength.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sat, Sep 27" · axis: "Sep 27" · "short": "Sat 27" · "letter": "S" */
export function fmtDay(key, mode) {
  const d = parseKey(key);
  if (mode === "letter") return WD[d.getDay()][0];
  if (mode === "short") return `${WD[d.getDay()]} ${d.getDate()}`;
  if (mode === true) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${WD[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const color = (id) => METRICS[id].color;
const label = (id) => METRICS[id].label;
const CHECK = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const OPEN = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const DASH = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M5 8h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const FLAME = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M8.2 1.5c.4 2.3-1.4 3.4-2.5 4.9C4.6 7.8 4 9 4 10.3 4 12.9 5.9 14.5 8 14.5s4-1.5 4-4.1c0-1.6-.8-2.8-1.6-3.6.1 1.2-.4 2.1-1.2 2.4.6-2.8-.2-5.8-1-7.7z" fill="currentColor"/></svg>`;
const GLYPH = { hit: CHECK, miss: CROSS, none: DASH, pending: OPEN, off: DASH };
const STATUS_WORD = { hit: "Hit", miss: "Missed", none: "No data", pending: "In progress", off: "Rest day (planned)" };
const NOT_ENOUGH = `<span class="nodata-inline">Not enough data yet</span>`;
const SRC = { manual: "Logged by you", apple: "Apple Health", legacy: "Older entry" };

/** What the goal was measured at, in words. */
function goalValue(id, day, g) {
  switch (id) {
    case "calories": return day?.kcal != null ? `${fmtInt(day.kcal)} kcal` : "—";
    case "protein": return day?.protein != null ? `${day.protein}g / ${g.protein}g` : "—";
    case "fiber": return day?.fiber != null ? `${day.fiber}g / ${g.fiber}g` : "—";
    case "steps": return day?.steps != null ? fmtInt(day.steps) : "—";
    case "active": return day?.activeKcal != null ? `${fmtInt(day.activeKcal)} / ${fmtInt(g.activeKcal)} kcal` : "—";
    case "exercise": return day?.exerciseMin != null ? `${fmtInt(day.exerciseMin)} / ${g.exerciseMin} min` : "—";
    case "sleep": return fmtDur(sleepMinutes(day));
    case "workout": return day?.workout == null ? "—" : day.workout ? (day.workouts?.length ? `${day.workouts.length} done` : "Done") : "Rest";
    case "creatine": return day?.creatine == null ? "—" : day.creatine ? "Taken" : "Skipped";
    default: return "—";
  }
}

/** What still stands between today and this goal. */
function remaining(id, day, g) {
  const food = foodStatus(day);
  const left = (v, target, unit, what) => (v == null ? `Nothing ${what} yet` : `${fmtInt(Math.max(0, target - v))}${unit} remaining`);
  switch (id) {
    case "calories": {
      const v = day?.kcal;
      if (v == null) return "Nothing logged yet";
      if (v < g.kcalLow) return `${fmtInt(g.kcalLow - v)} kcal to reach ${fmtInt(g.kcalLow)}`;
      return food === "complete" ? "In range" : "In range — mark food complete to count it";
    }
    case "protein": return left(day?.protein, g.protein, "g", "logged");
    case "fiber": return left(day?.fiber, g.fiber, "g", "logged");
    case "steps": return day?.steps == null ? "No steps synced yet" : `${fmtInt(g.steps - day.steps)} steps remaining`;
    case "active": return day?.activeKcal == null ? "Nothing synced yet" : `${fmtInt(g.activeKcal - day.activeKcal)} kcal remaining`;
    case "exercise": return day?.exerciseMin == null ? "Nothing synced yet" : `${fmtInt(g.exerciseMin - day.exerciseMin)} min remaining`;
    case "sleep": return "Log last night's sleep";
    case "workout": return "No workout yet";
    case "creatine": return "Not taken yet";
    default: return "";
  }
}

function tabs(act, options, current) {
  return `<div class="tabs" role="tablist">${options.map(([v, l]) =>
    `<button type="button" role="tab" class="tab${String(v) === String(current) ? " on" : ""}" aria-selected="${String(v) === String(current)}"
      data-act="${act}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
}

/* ── page chrome ───────────────────────────────────────────────────────── */

export function pageHeader(ctx, title, withGoals = true) {
  const s = dayScore(dayAt(ctx.days, ctx.today), ctx.g, true);
  const segs = s.detail.map((x) => `<i class="${x.status === "hit" ? "on" : x.status}" style="--c:${color(x.id)}" title="${esc(label(x.id))}: ${STATUS_WORD[x.status]}"></i>`).join("");
  return `<header class="page">
    <div>
      <div class="eyebrow">${esc(fmtDay(ctx.today))}</div>
      <h1>${esc(title)}</h1>
    </div>
    ${withGoals ? `<div class="goalmeter" aria-label="${s.hit} of ${s.total} goals hit today">
      <div class="gm-n"><b>${s.hit}/${s.total}</b> goals hit</div>
      <div class="gm-segs">${segs}</div>
    </div>` : ""}
    <button type="button" class="btn primary" data-act="log" data-key="${ctx.today}">Log today</button>
  </header>`;
}

export function demoBanner(ctx) {
  if (!ctx.state.demo || ctx.ui.demoHidden) return "";
  return `<div class="banner">
    <span><b>Sample data.</b> Made-up days so every chart has something to show, until your first real log or Apple Health sync.</span>
    <button type="button" class="btn" data-act="demo-hide">Keep exploring</button>
    <button type="button" class="btn light" data-act="demo-clear">Start my own log</button>
  </div>`;
}

/** Shown when older entries still need sorting, anywhere it matters. */
function reviewNudge(ctx) {
  const n = ctx.state.demo ? 0 : reviewItems(ctx.raw).length;
  if (!n) return "";
  return `<div class="banner soft"><span><b>${n} older day${n === 1 ? "" : "s"}</b> have food or sleep values from before sources were tracked. They're left out of every number until you confirm which are yours.</span>
    <a class="btn" href="#/settings" data-jump="sec-review">Review</a></div>`;
}

/* ── daily score + finish today ────────────────────────────────────────── */

export function scoreCard(ctx) {
  const day = dayAt(ctx.days, ctx.today);
  const s = dayScore(day, ctx.g, true);
  const pending = s.detail.filter((x) => x.status === "pending");
  const missed = s.detail.filter((x) => x.status === "miss");
  const hit = s.detail.filter((x) => x.status === "hit");
  const finish = pending.length
    ? `<div class="sec-l">Finish today</div><ul class="why">${pending.map((x) => `<li>
        <span class="st">${OPEN}</span><span class="nm">${esc(METRICS[x.id].short || label(x.id))}</span><span class="v">${esc(remaining(x.id, day, ctx.g))}</span></li>`).join("")}</ul>`
    : s.hit === s.total ? `<div class="sec-l">Every goal hit today</div>` : "";
  const miss = missed.length
    ? `<div class="sec-l">Missed</div><ul class="why">${missed.map((x) => `<li class="miss">
        <span class="st">${CROSS}</span><span class="nm">${esc(label(x.id))}</span><span class="v">${esc(goalValue(x.id, day, ctx.g))}</span></li>`).join("")}</ul>`
    : "";
  const done = hit.length
    ? `<div class="sec-l">Done</div><div class="donechips">${hit.map((x) => `<span ${tip(label(x.id), goalValue(x.id, day, ctx.g))}>${CHECK}${esc(METRICS[x.id].short || label(x.id))}</span>`).join("")}</div>`
    : "";
  return `<section class="card score">
    <div class="lbl">Today</div>
    <div class="big">${s.hit}<small>/${s.total}</small></div>
    <div class="of">goals hit · ${Math.round(s.pct * 100)}%</div>
    ${finish}${miss}${done}
  </section>`;
}

/* ── stat cards ────────────────────────────────────────────────────────── */

export function statCards(ctx) {
  const { g, today } = ctx;
  const d = dayAt(ctx.days, today);
  const gp = goalProgress(ctx.days, g, today);
  const sleep = sleepMinutes(d);
  const trend = weightSeries(ctx.days, addDays(today, -29), today).map((x) => x.avg);
  const st = (id) => goalStatus(id, d, g, true);
  const card = (id, value, unit, sub, pct, status, extra = "", cls = "") => `<div class="stat${status === "hit" ? " met" : ""}${value === "—" ? " empty" : ""}${cls}" style="--c:${color(id)}">
      <div class="txt">
        <div class="l">${esc(METRICS[id].short || label(id))}</div>
        <div class="n">${value}${unit && value !== "—" ? `<small>${unit}</small>` : ""}</div>
        <div class="s">${sub}</div>
        ${extra}
      </div>
      <div class="r">${ring({ pct, size: 58, stroke: 6, color: color(id), label: `${label(id)} ${Math.round(pct * 100)}%` })}
        ${status === "hit" ? `<span class="okdot">${CHECK}</span>` : ""}</div>
    </div>`;
  const of = (v, t) => (v == null ? 0 : v / t);
  const weightSub = gp.current == null ? "No weigh-ins yet"
    : `${gp.basis}${gp.basis === "7-day average" && gp.latest ? ` · latest ${fmt1(gp.latest.value)}` : ""} · ${gp.lost >= 0 ? "−" : "+"}${fmt1(Math.abs(gp.lost))} since start`;
  return `<section class="stats">
    ${card("weight", fmt1(gp.current), "lb", weightSub, gp.pct, null,
      sparkline(trend, { width: 300, height: 34, color: color("weight") }), " wide")}
    ${card("calories", fmtInt(d.kcal), "", d.kcal == null ? "Nothing logged" : `of ${fmtInt(g.kcalTarget)} kcal${foodStatus(d) === "partial" ? " · so far" : ""}`, of(d.kcal, g.kcalTarget), st("calories"))}
    ${card("protein", d.protein ?? "—", "g", d.protein == null ? "Nothing logged" : `of ${g.protein}g`, of(d.protein, g.protein), st("protein"))}
    ${card("steps", fmtInt(d.steps), "", d.steps == null ? "No data" : `of ${fmtInt(g.steps)}`, of(d.steps, g.steps), st("steps"))}
    ${card("sleep", esc(fmtDur(sleep)), "", sleep == null ? "Not logged" : `of ${g.sleepHours}h`, of(sleep, g.sleepHours * 60), st("sleep"))}
    ${card("active", fmtInt(d.activeKcal), "", d.activeKcal == null ? "No data" : `of ${fmtInt(g.activeKcal)} kcal`, of(d.activeKcal, g.activeKcal), st("active"))}
    ${card("exercise", fmtInt(d.exerciseMin), "min", d.exerciseMin == null ? "No data" : `of ${g.exerciseMin} min`, of(d.exerciseMin, g.exerciseMin), st("exercise"))}
  </section>`;
}

/* ── calorie ring ──────────────────────────────────────────────────────── */

export function calorieCard(ctx, key = ctx.today) {
  const { g } = ctx;
  const d = ctx.days[key] || {};
  const k = d.kcal;
  const food = foodStatus(d);
  const status = k == null ? `<span class="pill">Nothing logged</span>`
    : k > g.kcalHigh ? `<span class="pill warn">▲ Over by ${fmtInt(k - g.kcalHigh)}</span>`
    : k >= g.kcalLow ? (food === "complete" ? `<span class="pill ok">${CHECK} In range</span>` : `<span class="pill">In range so far</span>`)
    : `<span class="pill">${fmtInt(g.kcalLow - k)} to range</span>`;
  return `<section class="card cal-card">
    <h2>Calories <span class="sub">${key !== ctx.today ? `${esc(fmtDay(key, true))} · ` : ""}${food === "complete" ? "log complete" : food === "partial" ? (key === ctx.today ? "log in progress" : "partial log") : ""}</span></h2>
    <div class="bigring">
      ${ring({ pct: (k ?? 0) / g.kcalTarget, size: 232, stroke: 18, color: color("calories"),
        zone: [g.kcalLow / g.kcalTarget, g.kcalHigh / g.kcalTarget], label: k == null ? "Nothing logged" : `${k} of ${g.kcalTarget} kcal` })}
      <div class="center">
        <div class="n">${k == null ? "—" : fmtInt(k)}</div>
        <div class="of">/ ${fmtInt(g.kcalTarget)} kcal</div>
        ${status}
      </div>
    </div>
    <div class="zonekey"><i style="--c:${color("calories")}"></i>Success zone ${fmtInt(g.kcalLow)}–${fmtInt(g.kcalHigh)} kcal, drawn at the top of the ring</div>
  </section>`;
}

/* ── macros ────────────────────────────────────────────────────────────── */

export function macroCard(ctx, key = ctx.today) {
  const { g } = ctx;
  const d = ctx.days[key] || {};
  const mini = (id, size, stroke) => {
    const v = d[id], t = g[id];
    return `<div class="macro ${id}">
      <div class="mring">${ring({ pct: (v ?? 0) / t, size, stroke, color: color(id), label: v == null ? `${label(id)} not logged` : `${label(id)} ${v} of ${t} g` })}
        <div class="center"><b>${v ?? "—"}</b><small>/ ${t}g</small></div></div>
      <div class="ml"><i style="--c:${color(id)}"></i>${esc(label(id))}${id === "protein" ? `<span class="tag">Primary</span>` : ""}</div>
    </div>`;
  };
  const mc = macroCalories(d);
  let comp;
  if (!mc || !mc.total) {
    comp = `<div class="comp-h"><span>Calorie composition</span><span>Nothing logged yet</span></div><div class="compbar"><span class="seg empty"></span></div>`;
  } else {
    const parts = ["protein", "carbs", "fat"].map((id) => ({ id, kcal: mc[id], g: d[id] }));
    const bar = parts.filter((p) => p.kcal > 0).map((p) => `<span class="seg" style="flex:${p.kcal} 0 0;--c:${color(p.id)}" ${tip(label(p.id), `${p.g}g · ${fmtInt(p.kcal)} kcal`, `${Math.round((p.kcal / mc.total) * 100)}% of calories`)}></span>`).join("");
    const legend = parts.map((p) => `<div><i style="--c:${color(p.id)}"></i><span class="nm">${esc(label(p.id))}</span>
        <b>${p.g == null ? "—" : `${p.g}g`}</b><span class="pc">${p.g == null ? "not logged" : `${Math.round((p.kcal / mc.total) * 100)}%`}</span></div>`).join("");
    comp = `<div class="comp-h"><span>Calorie composition</span><span>${fmtInt(mc.total)} kcal from macros</span></div>
      <div class="compbar">${bar}</div><div class="complegend">${legend}</div>`;
  }
  return `<section class="card macros">
    <h2>Macros${key !== ctx.today ? ` <span class="sub">${esc(fmtDay(key, true))}</span>` : ""}</h2>
    <div class="mrow">
      ${mini("protein", 132, 13)}
      <div class="sec">${mini("carbs", 86, 8)}${mini("fat", 86, 8)}</div>
    </div>
    <div class="comp">${comp}</div>
  </section>`;
}

/* ── today vs average ──────────────────────────────────────────────────── */

export function todayVsAvg(ctx) {
  const { days, today } = ctx;
  const a = addDays(today, -14), b = addDays(today, -1);
  const d = days[today];
  const rows = [
    ["calories", (v) => fmtInt(v), 0, d?.kcal],
    ["protein", (v) => `${Math.round(v)}g`, 1, d?.protein],
    ["steps", (v) => fmtK(v), 1, d?.steps],
    ["active", (v) => fmtInt(v), 1, d?.activeKcal],
    ["exercise", (v) => `${Math.round(v)}m`, 1, d?.exerciseMin],
    ["sleep", (v) => fmtDur(v), 1, sleepMinutes(d)],
  ].map(([id, f, better, t]) => {
    const { value: avg, n } = averageOf(id, days, a, b);
    const basis = id in { calories: 1, protein: 1 } ? `${n} complete food day${n === 1 ? "" : "s"}` : `${n} day${n === 1 ? "" : "s"} with data`;
    const name = `<span class="nm"><i style="--c:${color(id)}"></i>${esc(METRICS[id].short || label(id))}</span>`;
    if (t == null || avg == null) {
      return `<div class="tva" ${tip(label(id), avg == null ? `Needs ${MIN.avg}+ days — has ${n}` : "Nothing today yet")}>${name}<span class="delta"></span>
        <span class="tv"><span class="t">${t == null ? "—" : esc(f(t))}</span><span class="avg">${avg == null ? "Not enough data yet" : `vs ${esc(f(avg))} avg`}</span></span></div>`;
    }
    const diff = t - avg;
    const pct = avg ? diff / avg : 0;
    const hi = Math.max(t, avg) * 1.15;
    const flat = Math.abs(pct) < 0.01;
    return `<div class="tva" ${tip(label(id), `Today ${f(t)}${id === "calories" || id === "protein" ? " so far" : ""}`, `14-day avg ${f(avg)} (${basis})`)}>
      ${name}
      <span class="delta${flat ? "" : better && diff > 0 ? " up" : ""}">${flat ? "=" : diff > 0 ? "↑" : "↓"} ${Math.abs(Math.round(pct * 100))}%</span>
      <span class="tv"><span class="t">${esc(f(t))}</span><span class="avg">vs ${esc(f(avg))} avg</span></span>
      <span class="bullet"><span class="fill" style="width:${((t / hi) * 100).toFixed(1)}%;--c:${color(id)}"></span><span class="avgtick" style="left:${((avg / hi) * 100).toFixed(1)}%"></span></span>
    </div>`;
  }).join("");
  return `<section class="card vsavg">
    <h2>Today vs average <span class="sub">last 14 days, days with data only</span></h2>
    <div class="tvas">${rows}</div>
  </section>`;
}

/* ── week heatmap ──────────────────────────────────────────────────────── */

export function heatmap(ctx) {
  const { g, today, ui } = ctx;
  const mon = addDays(mondayOf(today), ui.heatWeek * 7);
  const keys = range(mon, addDays(mon, 6));
  const ids = trackedIds(g);
  const head = keys.map((k) => `<div class="hh${k === today ? " today" : ""}"><span>${WD[parseKey(k).getDay()]}</span><b>${parseKey(k).getDate()}</b></div>`).join("");
  const rows = ids.map((id) => `<div class="hl"><i style="--c:${color(id)}"></i>${esc(METRICS[id].short || label(id))}</div>` + keys.map((k) => {
    const future = k > today;
    const stt = future ? "future" : goalStatus(id, ctx.days[k] || { key: k }, g, k === today);
    const cls = { hit: "on", miss: "miss", none: "none", pending: "pending", off: "none off", future: "none future" }[stt];
    const word = future ? "Upcoming" : STATUS_WORD[stt];
    const val = !future && stt !== "none" && stt !== "off" ? ` — ${goalValue(id, ctx.days[k], g)}` : "";
    return `<div class="hc ${cls}${k === today ? " today" : ""}" style="--c:${color(id)}" ${tip(`${label(id)} · ${fmtDay(k)}`, `${word}${val}`)}>${stt === "hit" ? CHECK : stt === "miss" ? CROSS : ""}</div>`;
  }).join("")).join("");
  let hit = 0, miss = 0, none = 0;
  const foot = keys.map((k) => {
    if (k > today) return `<div class="hf"></div>`;
    const s = dayScore(ctx.days[k], g, k === today);
    hit += s.hit; miss += s.miss; none += s.none;
    if (!s.logged && !s.pending) return `<div class="hf" ${tip(fmtDay(k), "No data")}>—</div>`;
    return `<div class="hf${s.hit === s.total ? " perfect" : ""}" ${tip(fmtDay(k), `${s.hit} hit · ${s.miss} missed · ${s.none} no data${s.pending ? ` · ${s.pending} in progress` : ""}`)}>${s.hit}/${s.total}</div>`;
  }).join("");
  return `<section class="card heat">
    <div class="cardhead">
      <h2>Week at a glance <span class="sub">${esc(fmtDay(keys[0], true))} – ${esc(fmtDay(keys[6], true))} · ${hit} hit · ${miss} missed · ${none} no data</span></h2>
      <div class="pager">
        <button type="button" class="nav" data-act="heat" data-v="-1" aria-label="Previous week">‹</button>
        <button type="button" class="nav" data-act="heat" data-v="0"${ui.heatWeek === 0 ? " disabled" : ""}>This week</button>
        <button type="button" class="nav" data-act="heat" data-v="1" aria-label="Next week"${ui.heatWeek >= 0 ? " disabled" : ""}>›</button>
      </div>
    </div>
    <div class="hgrid" style="--rows:${ids.length}">
      <div></div>${head}
      ${rows}
      <div class="hl foot">Hit</div>${foot}
    </div>
    <div class="legend small"><span>${CHECK} Hit</span><span>${CROSS} Missed</span><span><i class="nokey"></i>No data</span><span><i class="pendkey"></i>In progress</span>${g.plan && trackedIds(g).includes("workout") ? `<span><i class="offkey"></i>Planned rest</span>` : ""}</div>
  </section>`;
}

/* ── streaks ───────────────────────────────────────────────────────────── */

export function streaksCard(ctx) {
  const list = trackedIds(ctx.g)
    .map((id) => ({ id, ...streak(id, ctx.days, ctx.g, ctx.today) }))
    .sort((a, b) => b.current - a.current || b.best - a.best);
  const rows = list.map((s) => `<div class="streak${s.current ? "" : " cold"}${s.current && s.current === s.best ? " record" : ""}" style="--c:${color(s.id)}">
      <span class="fl">${FLAME}</span>
      <span class="nm">${esc(METRICS[s.id].short || label(s.id))}</span>
      <span class="cur"><b>${s.current}</b> day${s.current === 1 ? "" : "s"}</span>
      <span class="best">${s.current && s.current === s.best ? "Personal best" : `Best ${s.best}`}</span>
      <span class="sbar"><span style="width:${s.best ? ((s.current / s.best) * 100).toFixed(1) : 0}%"></span></span>
    </div>`).join("");
  return `<section class="card streaks"><h2>Streaks</h2><div class="slist">${rows}</div>
    <p class="foot-note">A day with no data pauses a streak; a miss, or three days in a row without data, ends it.</p></section>`;
}

/* ── weekly review ─────────────────────────────────────────────────────── */

export function weeklyReviewCard(ctx) {
  const r = weeklyReview(ctx.days, ctx.g, ctx.today);
  const rateTxt = (hit, judged) => (judged ? `${hit}/${judged}` : "—");
  const goals = r.perGoal.map((x) => `<div class="rg" ${tip(label(x.id), `${x.hit} hit of ${x.judged} judged${x.none ? ` · ${x.none} no data` : ""}`, x.prevJudged ? `Same days last week: ${x.prevHit}/${x.prevJudged}` : "")}>
      <i style="--c:${color(x.id)}"></i><span>${esc(METRICS[x.id].short || label(x.id))}</span><b>${rateTxt(x.hit, x.judged)}</b></div>`).join("");
  const w = r.weight.change;
  const weightLine = w == null ? "7-day weight average: not enough weigh-ins" : `7-day weight average ${w < -0.05 ? "↓" : w > 0.05 ? "↑" : "→"} ${Math.abs(w).toFixed(1)} lb`;
  const win = r.win ? `${label(r.win.id)} — ${r.win.hit}/${r.win.judged}` : null;
  const gap = r.gap ? `${label(r.gap.id)} — ${r.gap.hit}/${r.gap.judged}` : null;
  const change = r.change == null ? null : `${r.change >= 0 ? "+" : "−"}${Math.abs(Math.round(r.change * 100))} pts vs the same days last week`;
  return `<section class="card review">
    <h2>This week <span class="sub">${esc(fmtDay(r.from, true))} – ${esc(fmtDay(r.to, true))}${r.dayCount < 7 ? ` · ${r.dayCount} day${r.dayCount === 1 ? "" : "s"} in` : ""}</span></h2>
    <div class="rv-top">
      <div class="rv-n"><b>${r.hit}</b><small>/${r.judged}</small><span>goals hit${r.none ? ` · ${r.none} no data` : ""}</span></div>
      <div class="rv-side"><span>${r.workouts} workout${r.workouts === 1 ? "" : "s"}</span><span>${esc(weightLine)}</span></div>
    </div>
    <div class="rgrid">${goals}</div>
    <div class="rv-notes">
      <div><span>Biggest win</span><b>${win ? esc(win) : NOT_ENOUGH}</b></div>
      <div><span>Biggest gap</span><b>${gap ? esc(gap) : r.win ? "Nothing below 100%" : NOT_ENOUGH}</b></div>
      <div><span>Change</span><b>${change ? esc(change) : NOT_ENOUGH}</b></div>
    </div>
  </section>`;
}

/* ── consistency ───────────────────────────────────────────────────────── */

export function consistencyCard(ctx) {
  const { days, g, today } = ctx;
  const spans = [
    ["Last 7 days", addDays(today, -6), today],
    ["Last 30 days", addDays(today, -29), today],
    ["Previous 30 days", addDays(today, -59), addDays(today, -30)],
  ].map(([name, a, b]) => ({ name, ...adherence(days, g, a, b, today) }));
  const rows = spans.map((s) => `<div class="cons" ${tip(s.name, `${s.hit} hit of ${s.judged} judged goal-days`, `${s.none} goal-days with no data (left out)`)}>
      <span class="cn">${s.name}</span>
      <span class="cb"><span style="width:${s.rate == null ? 0 : (s.rate * 100).toFixed(1)}%"></span></span>
      <b>${s.rate == null ? "—" : `${Math.round(s.rate * 100)}%`}</b>
      <span class="cc">${s.rate == null ? `needs ${MIN.adherence}+ judged` : `${s.hit}/${s.judged}`}</span>
    </div>`).join("");
  const [, now, before] = spans;
  const delta = now.rate != null && before.rate != null ? now.rate - before.rate : null;
  return `<section class="card consistency">
    <h2>Consistency <span class="sub">goals hit ÷ goals judged</span></h2>
    ${rows}
    <p class="foot-note">${delta == null ? "Days with no data are left out, not counted as misses."
      : `${delta >= 0 ? "Up" : "Down"} ${Math.abs(Math.round(delta * 100))} points on the previous 30 days. Days with no data are left out, not counted as misses.`}</p>
  </section>`;
}

/* ── insights ──────────────────────────────────────────────────────────── */

export function insightsCard(ctx) {
  const list = insights(ctx.days, ctx.g, ctx.today);
  if (!list.length) return "";
  return `<section class="card insights">
    <h2>Insights <span class="sub">patterns in your own history</span></h2>
    ${list.map((x) => `<div class="ins"><p>${esc(x.text)}</p><span>${esc(x.a)} vs ${esc(x.b)}</span></div>`).join("")}
    <p class="foot-note">Correlations, not causes. Each needs ${MIN.insight}+ days on both sides and a 10%+ difference to appear.</p>
  </section>`;
}

/* ── weight ────────────────────────────────────────────────────────────── */

export function goalJourney(ctx) {
  const gp = goalProgress(ctx.days, ctx.g, ctx.today);
  const span = gp.start - gp.goal;
  const ticks = [];
  if (span > 0) {
    for (let w = Math.floor(gp.start / 5) * 5; w > gp.goal; w -= 5) {
      if (w >= gp.start) continue;
      const p = (gp.start - w) / span;
      ticks.push(`<span class="jt${gp.current != null && gp.current <= w ? " passed" : ""}" style="left:${(p * 100).toFixed(2)}%"><em>${w}</em></span>`);
    }
  }
  const pct = gp.pct * 100;
  return `<section class="card journey">
    <div class="cardhead"><h2>Goal journey <span class="sub">${gp.basis ? esc(gp.basis) : ""}</span></h2><span class="pct"><b>${gp.current == null ? "—" : `${pct.toFixed(1)}%`}</b> complete</span></div>
    <div class="jwrap">
      <div class="jtrack">
        <div class="jfill" data-anim-w="${pct.toFixed(2)}"></div>
        ${ticks.join("")}
        <div class="jmark" data-anim-left="${pct.toFixed(2)}"><span class="jnow">${gp.current == null ? "—" : fmt1(gp.current)}<small>lb</small></span></div>
      </div>
      <div class="jends">
        <div><b>${fmt1(gp.start)} lb</b><span>Start</span></div>
        <div class="r"><b>${fmt1(gp.goal)} lb</b><span>Goal</span></div>
      </div>
    </div>
    <div class="jstats">
      <div><span>Lost</span><b>${fmt1(gp.lost)}<small>lb</small></b></div>
      <div><span>Remaining</span><b>${gp.remaining == null ? "—" : fmt1(Math.max(0, gp.remaining))}<small>lb</small></b></div>
      <div><span>Complete</span><b>${gp.current == null ? "—" : Math.round(pct)}<small>%</small></b></div>
    </div>
  </section>`;
}

export function weeklyWeightCard(ctx) {
  const w = weeklyWeight(ctx.days, ctx.today);
  const ch = w.change;
  const dir = ch == null ? "" : ch < -0.05 ? "down" : ch > 0.05 ? "up" : "flat";
  const line = ch == null ? `Not enough weigh-ins yet (needs ${MIN.weightWeek} in each week)`
    : dir === "flat" ? "Holding steady this week"
    : `${dir === "down" ? "↓" : "↑"} ${Math.abs(ch).toFixed(1)} lb this week`;
  return `<section class="card weekly">
    <h2>Weekly trend <span class="sub">7-day avg vs prior 7</span></h2>
    <div class="wk-n">${fmt1(w.lastWeek)} <span class="arrow">→</span> ${fmt1(w.thisWeek)}<small>lb</small></div>
    <div class="wk-ch ${dir}">${line}</div>
    <div class="wk-spark">${sparkline(w.weeks.map((x) => x.avg), { width: 260, height: 48 })}</div>
    <div class="wk-cap"><span>8 weeks ago</span><span>Weekly averages</span><span>Now</span></div>
  </section>`;
}

function weightWindow(ctx) {
  const keys = Object.keys(ctx.days).filter((k) => k <= ctx.today).sort();
  const first = keys[0] || ctx.today;
  const r = ctx.ui.weightRange;
  const a = r === "all" ? first : addDays(ctx.today, -(Number(r) - 1));
  return [a < first ? first : a, ctx.today];
}

export function weightJourney(ctx) {
  const ws = weightStats(ctx.days, ctx.g, ctx.today);
  const [a, b] = weightWindow(ctx);
  const series = weightSeries(ctx.days, a, b).filter((s) => s.v != null).reverse();
  const rows = series.map((s) => `<tr><td>${esc(fmtDay(s.key))}</td><td>${s.v.toFixed(1)}</td><td>${s.avg != null ? s.avg.toFixed(1) : "—"}</td></tr>`).join("");
  const signed = (v) => (v == null ? null : `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(1)}`);
  const dirWord = { down: "Trending down", up: "Trending up", flat: "Holding steady" }[ws.direction];
  const etaTxt = ws.eta?.reached ? "Goal reached"
    : ws.eta ? `${MONTHS[parseKey(ws.eta.date).getMonth()]} ${parseKey(ws.eta.date).getFullYear()}` : null;
  const stat = (name, val, unit, note, hl = false) => `<div${hl ? ' class="hl"' : ""}><span>${name}</span>
      <b>${val == null ? NOT_ENOUGH : `${val}${unit ? `<small>${unit}</small>` : ""}`}</b>${note ? `<em>${note}</em>` : ""}</div>`;
  return `<section class="card wj">
    <div class="cardhead">
      <h2>Weight journey</h2>
      ${tabs("weight-range", [[30, "30D"], [90, "90D"], ["all", "All"]], ctx.ui.weightRange)}
    </div>
    <div class="wjstats">
      ${stat("7-day average", ws.avg7 == null ? null : fmt1(ws.avg7), "lb", ws.avg7 == null ? `needs ${MIN.weightWeek} weigh-ins this week` : `${ws.avg7n} weigh-ins`, true)}
      ${stat("30-day change", signed(ws.change30), "lb", "7-day avg vs 30 days ago")}
      ${stat("Rate", signed(ws.perWeek), "lb/wk", dirWord ? `${dirWord} · last 28 days` : `needs ${MIN.trend} weigh-ins over 2+ weeks`)}
      ${stat("Goal date", etaTxt, "", ws.eta?.date ? `at ${Math.abs(ws.eta.rate).toFixed(1)} lb/wk · ${ws.eta.basis} weigh-ins` : ws.eta?.reached ? "" : `needs ${MIN.eta} weigh-ins over 3+ weeks, trending down`)}
    </div>
    <div class="chartbox" data-chart="weight"></div>
    <div class="legend">
      <span><i class="linekey"></i>7-day average</span>
      <span><i class="dotkey"></i>Daily weigh-in</span>
      <span><i class="goalkey"></i>Goal ${fmt1(ctx.g.goalWeight)} lb</span>
    </div>
    <details class="datatable"><summary>Show data</summary>
      <table><thead><tr><th>Day</th><th>Weigh-in</th><th>7-day avg</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
  </section>`;
}

/* ── nutrition trends ──────────────────────────────────────────────────── */

const TREND_METRICS = ["calories", "protein", "carbs", "fat", "fiber"];

function trendRows(ctx) {
  const { ui, g } = ctx;
  const id = ui.trendMetric;
  return range(addDays(ctx.today, -(ui.trendRange - 1)), ctx.today).map((k) => {
    const d = ctx.days[k];
    const fs = foodStatus(d);
    const v = valueOf(id, d, { partialFood: true });
    let met = null;
    if (v != null && fs === "complete") {
      if (id === "calories") met = v >= g.kcalLow && v <= g.kcalHigh;
      else if (id === "carbs" || id === "fat") met = v <= g[id] * 1.1 && v >= g[id] * 0.8;
      else met = v >= g[id];
    }
    return { key: k, v, met, partial: fs === "partial" };
  });
}

export function nutritionTrends(ctx) {
  const { ui, g } = ctx;
  const id = ui.trendMetric;
  const rows = trendRows(ctx);
  const a = rows[0].key, b = ctx.today;
  const { value: avg, n } = averageOf(id, ctx.days, a, b, MIN.food);
  const cov = foodCoverage(ctx.days, a, b);
  const complete = rows.filter((r) => r.met != null);
  const on = complete.filter((r) => r.met).length;
  const unit = id === "calories" ? "kcal" : "g";
  const targetText = id === "calories" ? `${fmtInt(g.kcalLow)}–${fmtInt(g.kcalHigh)} kcal`
    : id === "carbs" || id === "fat" ? `~${g[id]}g` : `≥ ${g[id]}g`;
  const table = [...rows].reverse().map((r) => `<tr><td>${esc(fmtDay(r.key))}</td><td>${r.v == null ? "—" : `${fmtInt(r.v)}${r.partial ? " (partial)" : ""}`}</td><td>${r.met == null ? "" : r.met ? "✓" : "○"}</td></tr>`).join("");
  return `<section class="card trends">
    <div class="cardhead">
      <h2>Nutrition trends <span class="sub">logged by you only</span></h2>
      ${tabs("trend-range", [[7, "7D"], [30, "30D"], [90, "90D"]], ui.trendRange)}
    </div>
    ${tabs("trend-metric", TREND_METRICS.map((m) => [m, label(m)]), id)}
    <div class="trstats">
      <div><span>Average</span><b>${avg == null ? NOT_ENOUGH : `${fmtInt(avg)}<small>${unit}</small>`}</b><em>${n} complete day${n === 1 ? "" : "s"}${avg == null ? ` — needs ${MIN.food}` : ""}</em></div>
      <div><span>Target</span><b class="t">${esc(targetText)}</b></div>
      <div><span>On target</span><b>${complete.length ? `${on}<small>/ ${complete.length}</small>` : NOT_ENOUGH}</b><em>complete days only</em></div>
      <div><span>Logging</span><b class="t">${cov.complete} complete</b><em>${cov.partial} partial · ${cov.none} no data</em></div>
    </div>
    <div class="chartbox" data-chart="trend"></div>
    <div class="legend">
      <span><i class="dotkey" style="--c:${color(id)}"></i>On target</span>
      <span><i class="dotkey off" style="--c:${color(id)}"></i>Off target</span>
      <span><i class="dotkey part" style="--c:${color(id)}"></i>Partial log (not averaged)</span>
      <span><i class="linekey" style="--c:${color(id)}"></i>7-day average</span>
      <span><i class="${id === "calories" ? "zonekey2" : "goalkey"}" style="--c:${color(id)}"></i>${id === "calories" ? "Success zone" : "Target"}</span>
    </div>
    <details class="datatable"><summary>Show data</summary>
      <table><thead><tr><th>Day</th><th>${esc(label(id))} (${unit})</th><th>Target</th></tr></thead><tbody>${table}</tbody></table>
    </details>
  </section>`;
}

/* ── sleep (manual only) ───────────────────────────────────────────────── */

function nights(ctx, n) {
  return range(addDays(ctx.today, -(n - 1)), ctx.today).map((k) => {
    const d = ctx.days[k];
    return { key: k, bed: nightOffset(d?.bed), wake: nightOffset(d?.wake), mins: sleepMinutes(d), today: k === ctx.today };
  });
}

export function sleepCard(ctx) {
  const list = nights(ctx, ctx.ui.sleepN).filter((x) => x.bed != null);
  const enough = list.length >= MIN.sleep;
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const beds = list.map((x) => x.bed), wakes = list.map((x) => x.wake);
  const mb = mean(beds);
  const spread = beds.length > 1 ? Math.sqrt(mean(beds.map((b) => (b - mb) ** 2))) : null;
  const tgt = { bed: nightOffset(ctx.g.bedTarget), wake: nightOffset(ctx.g.wakeTarget) };
  const onSchedule = list.filter((x) => tgt.bed != null && Math.abs(x.bed - tgt.bed) <= 30).length;
  const v = (x) => (enough ? x : NOT_ENOUGH);
  return `<section class="card sleepc">
    <div class="cardhead"><h2>Sleep <span class="sub">logged by you · ${list.length} of ${ctx.ui.sleepN} nights</span></h2>${tabs("sleep-n", [[7, "7 nights"], [14, "14 nights"]], ctx.ui.sleepN)}</div>
    <div class="sleepstats">
      <div><span>Average</span><b>${v(esc(fmtDur(mean(list.map((x) => x.mins)))))}</b></div>
      <div><span>Avg bedtime</span><b>${v(esc(fmtClock(mb)))}</b></div>
      <div><span>Avg wake</span><b>${v(esc(fmtClock(mean(wakes))))}</b></div>
      <div><span>Bedtime spread</span><b>${v(spread == null ? "—" : `±${Math.round(spread)}m`)}</b></div>
      <div><span>On schedule</span><b>${v(`${onSchedule}<small>/ ${list.length}</small>`)}</b><em>bed within 30m of ${esc(fmtClock(tgt.bed))}</em></div>
    </div>
    <div class="chartbox" data-chart="sleep"></div>
  </section>`;
}

/* ── fitness ───────────────────────────────────────────────────────────── */

const TYPE_COLORS = [
  [/strength|weight|functional|core/i, "Strength", "#F08A78"],
  [/run/i, "Running", "#5CC8F0"],
  [/walk|hik/i, "Walking", "#B5D86A"],
  [/cycl|bike|spin/i, "Cycling", "#F3E96C"],
  [/hiit|interval|cross|boxing|kickbox/i, "HIIT", "#F25C7A"],
  [/yoga|pilates|flex|cooldown|stretch|mind/i, "Mobility", "#9D8CF5"],
  [/swim|row|water|padd/i, "Water", "#45B3C8"],
];
export function typeColor(type) {
  for (const [re, , c] of TYPE_COLORS) if (re.test(type)) return c;
  return "#94949E";
}
function typeGroup(type) {
  for (const [re, name] of TYPE_COLORS) if (re.test(type)) return name;
  return "Other";
}

export function activityCard(ctx) {
  const { g, today } = ctx;
  const d = ctx.days[today] || {};
  const rings = [
    { id: "active", v: d.activeKcal, t: g.activeKcal, fmt: (v) => `${fmtInt(v)} / ${fmtInt(g.activeKcal)} kcal` },
    { id: "exercise", v: d.exerciseMin, t: g.exerciseMin, fmt: (v) => `${fmtInt(v)} / ${g.exerciseMin} min` },
    { id: "steps", v: d.steps, t: g.steps, fmt: (v) => `${fmtInt(v)} / ${fmtInt(g.steps)}` },
  ];
  const ws = d.workouts || [];
  const legend = rings.map((r) => `<div class="ar" style="--c:${color(r.id)}">
      <i></i><span class="nm">${esc(label(r.id))}</span>
      <b>${r.v == null ? "—" : esc(r.fmt(r.v))}</b>
      <span class="pc">${r.v == null ? "no data" : `${Math.round((r.v / r.t) * 100)}%`}</span></div>`).join("");
  return `<section class="card activity">
    <h2>Today <span class="sub">${d.src?.activeKcal === "apple" || d.src?.steps === "apple" ? "from Apple Health" : ""}</span></h2>
    <div class="arow">
      <div class="arings">${concentric(rings.map((r) => ({ pct: r.v == null ? 0 : r.v / r.t, color: color(r.id), label: label(r.id) })), { size: 196, stroke: 17, gap: 5 })}</div>
      <div class="alegend">${legend}</div>
    </div>
    <div class="sec-l">Workouts today</div>
    ${ws.length ? `<div class="wtoday">${ws.map((w) => `<div class="wchip" style="--c:${typeColor(w.type)}"><i></i><b>${esc(shortType(w.type))}</b>
        <span>${esc(w.start.slice(11, 16))} · ${w.durationMin != null ? `${Math.round(w.durationMin)} min` : "—"}${w.kcal != null ? ` · ${fmtInt(w.kcal)} kcal` : ""}</span></div>`).join("")}</div>`
      : `<p class="hint">${d.appleFitness ? "None yet today." : "No workouts synced for today."}</p>`}
  </section>`;
}

export function fitnessStatsCard(ctx) {
  const { today } = ctx;
  const mon = mondayOf(today);
  const wk = fitnessTotals(ctx.days, mon, today);
  const m30 = fitnessTotals(ctx.days, addDays(today, -29), today);
  const streakN = workoutStreak(ctx.days, today);
  const cell = (name, val, unit, note) => `<div><span>${name}</span><b>${val == null ? NOT_ENOUGH : `${val}${unit ? `<small>${unit}</small>` : ""}`}</b>${note ? `<em>${note}</em>` : ""}</div>`;
  return `<section class="card fstats">
    <h2>This week <span class="sub">${esc(fmtDay(mon, true))} – ${esc(fmtDay(today, true))}</span></h2>
    <div class="fgrid">
      ${cell("Workouts", wk.workouts, "", `${wk.workoutDays} day${wk.workoutDays === 1 ? "" : "s"}`)}
      ${cell("Exercise", wk.exercise == null ? null : fmtInt(wk.exercise), "min", wk.exercise == null ? "" : `${wk.exerciseDays} day${wk.exerciseDays === 1 ? "" : "s"} synced`)}
      ${cell("Active calories", wk.active == null ? null : fmtInt(wk.active), "kcal", "")}
      ${cell("Avg workout", m30.avgDuration == null ? null : Math.round(m30.avgDuration), "min", "last 30 days")}
      ${cell("Most common", m30.topType ? esc(shortType(m30.topType.type)) : null, "", m30.topType ? `${m30.topType.count} of ${m30.workouts} · 30 days` : "")}
      ${cell("Workout streak", streakN, streakN === 1 ? "day" : "days", "days in a row with a workout")}
    </div>
  </section>`;
}

export function workoutWeekCard(ctx) {
  const mon = addDays(mondayOf(ctx.today), ctx.ui.fitWeek * 7);
  const keys = range(mon, addDays(mon, 6));
  const tot = fitnessTotals(ctx.days, mon, keys[6] > ctx.today ? ctx.today : keys[6]);
  const groups = [...new Set(workoutsIn(ctx.days, mon, keys[6]).map((w) => typeGroup(w.type)))];
  const legend = groups.map((gname) => {
    const c = (TYPE_COLORS.find((t) => t[1] === gname) || [0, 0, "#94949E"])[2];
    return `<span><i style="--c:${c}"></i>${esc(gname)}</span>`;
  }).join("");
  return `<section class="card wweekc">
    <div class="cardhead">
      <h2>Workouts <span class="sub">${esc(fmtDay(keys[0], true))} – ${esc(fmtDay(keys[6], true))} · ${tot.workouts} workout${tot.workouts === 1 ? "" : "s"}${tot.exercise != null ? ` · ${fmtInt(tot.exercise)} exercise min` : ""}</span></h2>
      <div class="pager">
        <button type="button" class="nav" data-act="fitweek" data-v="-1" aria-label="Previous week">‹</button>
        <button type="button" class="nav" data-act="fitweek" data-v="0"${ctx.ui.fitWeek === 0 ? " disabled" : ""}>This week</button>
        <button type="button" class="nav" data-act="fitweek" data-v="1" aria-label="Next week"${ctx.ui.fitWeek >= 0 ? " disabled" : ""}>›</button>
      </div>
    </div>
    ${tot.workouts ? `<div class="chartbox" data-chart="wweek"></div>` : `<div class="nodata">No workouts in this week.</div>`}
    ${legend ? `<div class="legend">${legend}</div>` : ""}
  </section>`;
}

export function exerciseWeeksCard(ctx) {
  return `<section class="card exweeks">
    <h2>Exercise per week <span class="sub">last 12 weeks · target ${fmtInt(ctx.g.exerciseMin * 7)} min</span></h2>
    <div class="chartbox" data-chart="exweeks"></div>
  </section>`;
}

/** Six months of days, shaded by exercise minutes; a dot marks a workout. */
export function activityCalendar(ctx) {
  const { today, g } = ctx;
  const end = addDays(mondayOf(today), 6);
  const start = addDays(mondayOf(today), -7 * 25);
  const weeks = [];
  for (let k = start; k <= end; k = addDays(k, 7)) weeks.push(k);
  const level = (m) => (m == null ? null : m >= g.exerciseMin ? 4 : m >= g.exerciseMin * 0.66 ? 3 : m >= g.exerciseMin * 0.33 ? 2 : m > 0 ? 1 : 0);
  let months = "";
  const cols = weeks.map((wk, i) => {
    const first = parseKey(wk);
    if (i === 0 || parseKey(addDays(wk, -7)).getMonth() !== first.getMonth()) {
      months += `<span style="grid-column:${i + 1}">${MONTHS[first.getMonth()]}</span>`;
    }
    return range(wk, addDays(wk, 6)).map((k) => {
      if (k > today) return `<i class="ac future"></i>`;
      const d = ctx.days[k];
      const lv = level(d?.exerciseMin);
      const wn = d?.workouts?.length || 0;
      return `<i class="ac${lv == null ? " nd" : ` l${lv}`}${wn ? " w" : ""}" ${tip(fmtDay(k), d?.exerciseMin != null ? `${fmtInt(d.exerciseMin)} exercise min` : "No data", wn ? d.workouts.map((w) => shortType(w.type)).join(", ") : "")}></i>`;
    }).join("");
  }).join("");
  const byMonth = {};
  for (const w of workoutsIn(ctx.days, start, today)) {
    const m = w.key.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  const monthsList = Object.entries(byMonth).slice(-6).map(([m, n]) => `<span><b>${n}</b> ${MONTHS[Number(m.slice(5)) - 1]}</span>`).join("");
  return `<section class="card acal">
    <h2>Activity <span class="sub">6 months · shade = exercise minutes, dot = workout</span></h2>
    <div class="acwrap"><div class="acmonths" style="--w:${weeks.length}">${months}</div>
      <div class="acgrid" style="--w:${weeks.length}">${cols}</div></div>
    <div class="acfoot">
      <div class="legend small"><span>Less</span>${[0, 1, 2, 3, 4].map((l) => `<i class="ac l${l}"></i>`).join("")}<span>More</span><span><i class="ac nd"></i>No data</span></div>
      ${monthsList ? `<div class="acmonthsum">Workouts: ${monthsList}</div>` : ""}
    </div>
  </section>`;
}

export function workoutMixCard(ctx) {
  const ws = workoutsIn(ctx.days, addDays(ctx.today, -29), ctx.today);
  if (!ws.length) return `<section class="card mix"><h2>Workout mix <span class="sub">30 days</span></h2><div class="nodata">No workouts in the last 30 days.</div></section>`;
  const by = {};
  for (const w of ws) {
    const b = by[w.type] ||= { n: 0, min: 0, kcal: 0 };
    b.n += 1; b.min += w.durationMin || 0; b.kcal += w.kcal || 0;
  }
  const rows = Object.entries(by).sort((a, b) => b[1].min - a[1].min);
  const max = rows[0][1].min || 1;
  return `<section class="card mix">
    <h2>Workout mix <span class="sub">30 days · by minutes</span></h2>
    ${rows.map(([t, b]) => `<div class="mixrow" ${tip(t, `${b.n} workout${b.n === 1 ? "" : "s"}`, `${fmtInt(b.min)} min · ${fmtInt(b.kcal)} active kcal`)}>
      <span class="mn"><i style="--c:${typeColor(t)}"></i>${esc(shortType(t))}</span>
      <span class="mb"><span style="width:${((b.min / max) * 100).toFixed(1)}%;--c:${typeColor(t)}"></span></span>
      <span class="mv"><b>${fmtInt(b.min)}</b> min · ${b.n}×</span>
    </div>`).join("")}
  </section>`;
}

export function recentWorkouts(ctx) {
  const ws = workoutsIn(ctx.days, addDays(ctx.today, -60), ctx.today).reverse().slice(0, 8);
  if (!ws.length) return "";
  return `<section class="card recent">
    <h2>Recent workouts</h2>
    ${ws.map((w) => `<button type="button" class="wrow" data-act="day" data-key="${w.key}">
      <i style="--c:${typeColor(w.type)}"></i>
      <span class="wt"><b>${esc(w.type)}</b><span>${esc(fmtDay(w.key))} · ${esc(w.start.slice(11, 16))}</span></span>
      <span class="wv">${w.durationMin != null ? `<b>${Math.round(w.durationMin)}</b> min` : "—"}</span>
      <span class="wv">${w.kcal != null ? `<b>${fmtInt(w.kcal)}</b> kcal` : "—"}</span>
      <span class="wv">${w.avgHR != null ? `<b>${Math.round(w.avgHR)}</b> bpm` : ""}</span>
    </button>`).join("")}
  </section>`;
}

export function stepsCard(ctx) {
  const { g, today } = ctx;
  const s = ctx.days[today]?.steps;
  const avg7 = averageOf("steps", ctx.days, addDays(today, -6), today);
  const rows = range(addDays(today, -6), today).map((k) => ({ key: k, v: valueOf("steps", ctx.days[k]), today: k === today }));
  return `<section class="card steps">
    <h2>Steps</h2>
    <div class="bigring sm">
      ${ring({ pct: (s ?? 0) / g.steps, size: 184, stroke: 15, color: color("steps"), label: s == null ? "No step data" : `${s} of ${g.steps} steps` })}
      <div class="center"><div class="n">${s == null ? "—" : fmtInt(s)}</div><div class="of">of ${fmtInt(g.steps)}</div></div>
    </div>
    <div class="stepmeta"><span>7-day average${avg7.value != null ? ` · ${avg7.n} days` : ""}</span><b>${avg7.value == null ? NOT_ENOUGH : fmtInt(avg7.value)}</b></div>
    ${miniBars(rows, { color: color("steps"), target: g.steps, fmtDay })}
  </section>`;
}

/* ── calendar + day details ────────────────────────────────────────────── */

/** Tint for a day's hits: 7/7 reads strongest; days without data stay untinted. */
const shade = (pct) => (0.04 + Math.pow(Math.max(0, pct), 1.5) * 0.46).toFixed(3);

export function calendar(ctx) {
  const { g, today, ui } = ctx;
  const t = parseKey(today);
  const first = new Date(t.getFullYear(), t.getMonth() + ui.calMonth, 1);
  const y = first.getFullYear(), m = first.getMonth();
  const firstKey = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const start = mondayOf(firstKey);
  const lastDay = new Date(y, m + 1, 0).getDate();
  const endKey = `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const end = addDays(mondayOf(endKey), 6);
  const cells = range(start, end).map((k) => {
    const d = ctx.days[k];
    const inMonth = parseKey(k).getMonth() === m;
    const future = k > today;
    const s = dayScore(d, g, k === today);
    const hasData = !future && (s.logged || s.pending > 0 && !!d);
    const cls = ["cell", inMonth ? "" : "outside", k === today ? "today" : "", future ? "future" : "",
      hasData ? "" : future ? "" : "nodata", hasData && s.hit === s.total ? "perfect" : ""].filter(Boolean).join(" ");
    const food = foodStatus(d);
    const body = hasData ? `<div class="cs">
        <span class="sc">${s.hit}/${s.total}${s.hit === s.total ? ` ${CHECK}` : ""}</span>
        ${d.kcal != null ? `<span><b>${fmtInt(d.kcal)}</b> kcal${food === "partial" ? " ·part" : ""}</span>` : ""}
        ${d.protein != null ? `<span><b>${d.protein}g</b> protein</span>` : ""}
        ${d.steps != null ? `<span><b>${fmtK(d.steps)}</b> steps</span>` : ""}
        ${d.weight != null ? `<span><b>${fmt1(d.weight)}</b> lb</span>` : ""}
        ${s.none ? `<span class="nd">${s.none} no data</span>` : ""}
      </div>` : !future ? `<div class="cs"><span class="nd">No data</span></div>` : "";
    return `<button type="button" class="${cls}" style="--a:${hasData ? shade(s.pct) : 0}"
        data-act="day" data-key="${k}"${future ? " disabled" : ""}
        aria-label="${esc(fmtDay(k))}${hasData ? `, ${s.hit} of ${s.total} goals hit, ${s.none} no data` : ", no data"}">
      <span class="num">${parseKey(k).getDate()}${k === today ? `<span class="tag">Today</span>` : ""}</span>${body}</button>`;
  }).join("");
  const scale = [0.2, 0.4, 0.6, 0.8, 1].map((p) => `<i style="--a:${shade(p)}"></i>`).join("");
  return `<section class="calwrap">
    <div class="calbar">
      <div class="month">${MONTHS_LONG[m]} ${y}</div>
      <button type="button" class="nav" data-act="cal" data-v="-1">‹ Prev</button>
      <button type="button" class="nav" data-act="cal" data-v="0"${ui.calMonth === 0 ? " disabled" : ""}>Today</button>
      <button type="button" class="nav" data-act="cal" data-v="1"${ui.calMonth >= 0 ? " disabled" : ""}>Next ›</button>
      <div class="calscale"><span>Fewer hit</span>${scale}<span>All hit</span><span class="ndkey"><i></i>No data</span></div>
    </div>
    <div class="cal">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => `<div class="wd">${w}</div>`).join("")}
      ${cells}
    </div>
  </section>`;
}

/** Everything known about one day, with where each number came from. */
export function dayDetails(ctx, key) {
  const d = ctx.days[key];
  const g = ctx.g;
  const s = dayScore(d, g, key === ctx.today);
  const src = (f) => (d?.src?.[f] ? `<span class="srcTag ${d.src[f]}">${SRC[d.src[f]]}</span>` : "");
  const val = (v, unit = "") => (v == null ? `<span class="muted">No data</span>` : `<b>${esc(v)}</b>${unit ? ` ${unit}` : ""}`);
  const food = foodStatus(d);
  const goals = s.detail.map((x) => `<li class="${x.status}"><span class="st">${GLYPH[x.status]}</span><span class="nm">${esc(label(x.id))}</span>
      <span class="v">${esc(STATUS_WORD[x.status])}${x.status !== "none" && goalValue(x.id, d, g) !== "—" ? ` · ${esc(goalValue(x.id, d, g))}` : ""}</span></li>`).join("");
  const line = (name, v, f) => `<div class="dl"><span>${name}</span><span>${v}${f ? src(f) : ""}</span></div>`;
  const ws = d?.workouts || [];
  return `<header>
      <div><div class="eyebrow">${esc(fmtDay(key))}</div>
        <h2>${s.hit}/${s.total} <span class="sub">goals hit${s.miss ? ` · ${s.miss} missed` : ""}${s.none ? ` · ${s.none} no data` : ""}${s.pending ? ` · ${s.pending} in progress` : ""}</span></h2></div>
      <button type="button" class="x" data-close aria-label="Close">×</button>
    </header>
    <ul class="dgoals">${goals}</ul>
    <div class="dsec"><h3>Food <span class="sub">${food === "complete" ? "complete log" : food === "partial" ? "partial log — left out of averages" : "no data"}</span></h3>
      ${line("Calories", val(d?.kcal != null ? fmtInt(d.kcal) : null, "kcal"), "kcal")}
      ${line("Protein", val(d?.protein, "g"), "protein")}
      ${line("Carbs", val(d?.carbs, "g"), "carbs")}
      ${line("Fat", val(d?.fat, "g"), "fat")}
      ${line("Fiber", val(d?.fiber, "g"), "fiber")}
      ${d?.food?.itemized ? MEALS.map((m) => {
        const slot = d.food.byMeal[m.id];
        if (!slot.entries.length) return "";
        return `<div class="dl meal"><span><b>${m.label}</b></span><span><b>${fmtInt(slot.totals.kcal)}</b> kcal · ${esc(macroLine(slot.totals))}</span></div>
          ${slot.entries.map((e) => `<div class="dl sub"><span>${esc(e.name)}</span><span>${fmtInt(e.kcal)} kcal ${srcTag(e.source)}</span></div>`).join("")}`;
      }).join("") : ""}
      ${d?.food?.quick && d.food.itemized ? `<div class="dl meal"><span><b>Quick add</b></span><span><b>${d.food.quick.kcal != null ? fmtInt(d.food.quick.kcal) : "—"}</b> kcal · ${esc(macroLine(d.food.quick))}</span></div>` : ""}
    </div>
    <div class="dsec"><h3>Sleep</h3>
      ${line("Bed → wake", d?.bed ? `<b>${esc(d.bed)} → ${esc(d.wake)}</b> · ${esc(fmtDur(sleepMinutes(d)))}` : `<span class="muted">Not logged</span>`, "bed")}
    </div>
    <div class="dsec"><h3>Activity</h3>
      ${line("Steps", val(d?.steps != null ? fmtInt(d.steps) : null), "steps")}
      ${line("Active calories", val(d?.activeKcal != null ? fmtInt(d.activeKcal) : null, "kcal"), "activeKcal")}
      ${line("Exercise", val(d?.exerciseMin, "min"), "exerciseMin")}
      ${ws.map((w) => `<div class="dl wk"><span><i style="--c:${typeColor(w.type)}"></i>${esc(w.type)}</span><span>${esc(w.start.slice(11, 16))}${w.durationMin != null ? ` · ${Math.round(w.durationMin)} min` : ""}${w.kcal != null ? ` · ${fmtInt(w.kcal)} kcal` : ""}${w.avgHR != null ? ` · ${Math.round(w.avgHR)} bpm` : ""}<span class="srcTag apple">Apple Health</span></span></div>`).join("")}
      ${!ws.length && d?.workout && !d?.lifts?.length ? line("Workout", "<b>Yes</b>", "workout") : ""}
      ${(d?.lifts || []).map((l) => `<div class="dl"><span>${esc(l.exercise)}</span><span>${esc(setsText(l.sets))}<span class="srcTag manual">Logged by you</span></span></div>`).join("")}
    </div>
    <div class="dsec"><h3>Body &amp; habits</h3>
      ${line("Weight", val(d?.weight != null ? fmt1(d.weight) : null, "lb"), "weight")}
      ${line("Creatine", d?.creatine == null ? `<span class="muted">No data</span>` : `<b>${d.creatine ? "Taken" : "Skipped"}</b>`, "creatine")}
    </div>
    <footer><button type="button" class="btn" data-close>Close</button><button type="button" class="btn" data-act="food-open" data-key="${key}">Food diary</button><button type="button" class="btn primary" data-act="log" data-key="${key}">Edit log</button></footer>`;
}

/* ── settings ──────────────────────────────────────────────────────────── */

const ICONS = {
  goals: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  apple: `<svg viewBox="0 0 20 20"><path d="M10 16.5s-6-3.6-6-8A3.4 3.4 0 0 1 10 6.4a3.4 3.4 0 0 1 6 2.1c0 4.4-6 8-6 8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  sliders: `<svg viewBox="0 0 20 20"><path d="M4 6h12M4 14h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="6" r="2.2" fill="var(--card)" stroke="currentColor" stroke-width="1.8"/><circle cx="13" cy="14" r="2.2" fill="var(--card)" stroke="currentColor" stroke-width="1.8"/></svg>`,
  lock: `<svg viewBox="0 0 20 20"><rect x="4.5" y="9" width="11" height="8" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 9V6.8a3 3 0 0 1 6 0V9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  data: `<svg viewBox="0 0 20 20"><ellipse cx="10" cy="5.5" rx="6" ry="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 5.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  eye: `<svg viewBox="0 0 20 20"><path d="M2.5 10S5.2 4.8 10 4.8 17.5 10 17.5 10 14.8 15.2 10 15.2 2.5 10 2.5 10z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  eyeOff: `<svg viewBox="0 0 20 20"><path d="M2.5 10S5.2 4.8 10 4.8 17.5 10 17.5 10 14.8 15.2 10 15.2 2.5 10 2.5 10z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 16L16 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  copy: `<svg viewBox="0 0 20 20"><rect x="7" y="7" width="9.5" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 4.8A1.8 1.8 0 0 0 11.2 3.5H5.3a1.8 1.8 0 0 0-1.8 1.8v5.9A1.8 1.8 0 0 0 4.8 13" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  rotate: `<svg viewBox="0 0 20 20"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.8v3.4h-3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pen: `<svg viewBox="0 0 20 20"><path d="M4 16l.8-3.2L13.5 4a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L7.2 15.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  trash: `<svg viewBox="0 0 20 20"><path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 10h6.6L14 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chevron: `<svg viewBox="0 0 20 20"><path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dumbbell: `<svg viewBox="0 0 20 20"><path d="M3 8v4M17 8v4M5.5 6v8M14.5 6v8M5.5 10h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  search: `<svg viewBox="0 0 20 20"><circle cx="8.8" cy="8.8" r="5.3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12.8 12.8l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  trophy: `<svg viewBox="0 0 20 20"><path d="M6 3.5h8v4a4 4 0 0 1-8 0zM6 5H3.5v1.2A2.8 2.8 0 0 0 6.3 9M14 5h2.5v1.2A2.8 2.8 0 0 1 13.7 9M10 11.5v3M7 16.5h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
const SECTIONS = {
  goals: { title: "Goals", color: "#F3E96C" },
  apple: { title: "Apple Health", color: "#F08A78" },
  sources: { title: "Data sources", color: "#8EDB57" },
  display: { title: "Dashboard defaults", color: "#5CC8F0" },
  training: { title: "Training plan", color: "#8EDB57" },
  food: { title: "Food lookup", color: "#45B3C8" },
  achievements: { title: "Achievements", color: "#F2A79C" },
  security: { title: "Sign-in & security", color: "#9D8CF5" },
  data: { title: "Your data", color: "#62D6C4" },
};
const ICON_OF = { goals: "goals", apple: "apple", sources: "data", display: "sliders", training: "dumbbell", food: "search", achievements: "trophy", security: "lock", data: "data" };

function secHead(id, desc) {
  const s = SECTIONS[id];
  return `<header class="sh"><span class="si" style="--c:${s.color}">${ICONS[ICON_OF[id]]}</span>
    <div><h2>${esc(s.title)}</h2><p>${desc}</p></div></header>`;
}
const row = (label, desc, control) => `<div class="srow"><div class="sl"><b>${label}</b>${desc ? `<span>${desc}</span>` : ""}</div><div class="ctl">${control}</div></div>`;
const seg = (k, options, current) => `<div class="tabs" role="radiogroup">${options.map(([v, l]) =>
  `<button type="button" role="radio" class="tab${String(v) === String(current) ? " on" : ""}" aria-checked="${String(v) === String(current)}"
    data-act="set-pref" data-k="${k}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
const toggle = (k, on, label) => `<button type="button" role="switch" aria-checked="${on}" aria-label="${esc(label)}"
  class="switch${on ? " on" : ""}" data-act="set-pref" data-k="${k}" data-v="${!on}"><i></i></button>`;
const iconBtn = (act, id, icon, label) => `<button type="button" class="ib" data-act="${act}" data-v="${esc(id)}" title="${esc(label)}" aria-label="${esc(label)}">${ICONS[icon]}</button>`;

/** The phone-style list at the top: each row says where things stand and jumps to it. */
function overview(ctx) {
  const st = ctx.settings || {};
  const g = ctx.g;
  const sync = ctx.state.lastSync?.at ? `Synced ${ago(new Date(ctx.state.lastSync.at))}` : (st.tokens?.length || st.envToken) ? "Waiting for first sync" : "Not connected";
  const pw = st.password?.source === "settings" ? "Password set here" : st.password?.source === "railway" ? "Password from Railway" : "No password";
  const n = ctx.state.demo ? 0 : Object.keys(ctx.days).length;
  const plan = ctx.g.plan;
  const count = (t) => (plan ? Object.values(plan.days).filter((x) => x === t).length : 0);
  const fl = st.food;
  const rows = [
    ["goals", `${fmtInt(g.kcalTarget)} kcal · ${g.protein}g protein · ${fmt1(g.goalWeight)} lb`],
    ["apple", sync],
    ["sources", "Food & sleep manual only"],
    ["food", fl ? `USDA ${fl.usda.set ? "key" : "demo key"}${fl.fatsecretId.set ? " · FatSecret" : ""}${fl.offEnabled ? " · Open Food Facts" : ""} · AI ${fl.anthropic.set ? "on" : "off"}` : ""],
    ["training", plan ? `${count("strength")} strength · ${count("cardio")} cardio · ${count("any")} any · ${count("rest")} rest` : "No plan yet"],
    ["achievements", ctx.ach ? `${ctx.ach.unlockedCount} / ${ctx.ach.total} unlocked` : ""],
    ["display", `${ctx.ui.weightRange === "all" ? "All" : `${ctx.ui.weightRange}D`} weight · ${ctx.ui.trendRange}D trends`],
    ["security", pw],
    ["data", `${n} day${n === 1 ? "" : "s"} stored`],
  ];
  return `<nav class="card overview" aria-label="Settings sections">${rows.map(([id, value]) =>
    `<button type="button" class="ov" data-act="jump" data-v="sec-${id}">
      <span class="si" style="--c:${SECTIONS[id].color}">${ICONS[ICON_OF[id]]}</span>
      <b>${esc(SECTIONS[id].title)}</b><span class="val">${esc(value)}</span><span class="chev">${ICONS.chevron}</span>
    </button>`).join("")}</nav>`;
}

function goalsSection(ctx) {
  const { g } = ctx;
  const num = (name, label, value, step = 1, unit = "") => `<label class="field"><span>${esc(label)}</span>
    <span class="inp"><input type="number" name="${name}" value="${esc(value)}" step="${step}" min="0" required>${unit ? `<em>${esc(unit)}</em>` : ""}</span></label>`;
  const checks = GOAL_IDS.map((id) => `<label class="chk"><input type="checkbox" name="tracked" value="${id}"${g.tracked.includes(id) ? " checked" : ""}><i style="--c:${color(id)}"></i>${esc(METRICS[id].label)}</label>`).join("");
  return `<form class="card sc" id="sec-goals" data-form="goals">
    ${secHead("goals", "Your targets. Every ring, streak and score on the dashboard is measured against these.")}
    <h3>Weight</h3>
    <div class="fields">${num("startWeight", "Starting weight", g.startWeight, 0.1, "lb")}${num("goalWeight", "Goal weight", g.goalWeight, 0.1, "lb")}</div>
    <h3>Daily targets</h3>
    <div class="fields">
      ${num("kcalTarget", "Calorie target", g.kcalTarget, 10, "kcal")}
      ${num("kcalLow", "Success zone from", g.kcalLow, 10, "kcal")}
      ${num("kcalHigh", "Success zone to", g.kcalHigh, 10, "kcal")}
      ${num("protein", "Protein", g.protein, 1, "g")}
      ${num("carbs", "Carbs", g.carbs, 1, "g")}
      ${num("fat", "Fat", g.fat, 1, "g")}
      ${num("fiber", "Fiber", g.fiber, 1, "g")}
      ${num("steps", "Steps", g.steps, 100)}
      ${num("activeKcal", "Active calories", g.activeKcal, 10, "kcal")}
      ${num("exerciseMin", "Exercise", g.exerciseMin, 5, "min")}
      ${num("sleepHours", "Sleep", g.sleepHours, 0.25, "h")}
      <label class="field"><span>Target bedtime</span><span class="inp"><input type="time" name="bedTarget" value="${esc(g.bedTarget)}" required></span></label>
      <label class="field"><span>Target wake</span><span class="inp"><input type="time" name="wakeTarget" value="${esc(g.wakeTarget)}" required></span></label>
    </div>
    <h3>Weekly calories</h3>
    <div class="fields">
      ${num("weeklyTarget", "Weekly target (0 = 7 × daily)", g.weeklyTarget || 0, 50, "kcal")}
      ${num("maintenance", "Estimated maintenance", g.maintenance, 10, "kcal")}
    </div>
    <p class="hint small">Maintenance is context only — the site never treats eating below your range as better, and never suggests making up for a higher day by eating less than your range.</p>
    <h3>Counted in the daily score</h3>
    <div class="checks">${checks}</div>
    <div class="actions"><button class="btn primary" type="submit">Save goals</button><span class="saved" data-saved hidden>Saved</span></div>
  </form>`;
}

function appleSection(ctx) {
  const st = ctx.settings || {};
  const s = ctx.state.lastSync;
  const url = `${location.origin}/api/ingest`;
  const status = s?.at
    ? `<div class="sync ok"><span class="dot"></span><div><b>Last sync ${esc(ago(new Date(s.at)))}</b>
        <span>${esc(s.source || "Apple Health")}${s.token ? ` via “${esc(s.token)}”` : ""} · ${s.days} day${s.days === 1 ? "" : "s"} updated${s.from ? ` (${esc(fmtDay(s.from, true))}${s.to !== s.from ? ` – ${esc(fmtDay(s.to, true))}` : ""})` : ""}</span></div></div>`
    : `<div class="sync"><span class="dot"></span><div><b>No sync yet</b><span>Create a token below, paste it into your iPhone app, and run it once.</span></div></div>`;

  const tokens = (st.tokens || []).map((t) => {
    const shown = ctx.revealed[t.id];
    const used = t.lastUsedAt ? `Last used ${ago(new Date(t.lastUsedAt))}` : "Never used";
    return `<div class="tok">
      <div class="tk-main">
        <b>${esc(t.name)}</b>
        <code class="${shown ? "full" : ""}">${esc(shown || t.preview.replace("…", "••••••••••••"))}</code>
        <span>${used} · created ${esc(fmtDay(t.createdAt.slice(0, 10), true))}</span>
      </div>
      <div class="tk-acts">
        ${iconBtn("token-reveal", t.id, shown ? "eyeOff" : "eye", shown ? "Hide" : "Reveal")}
        ${iconBtn("token-copy", t.id, "copy", "Copy")}
        ${iconBtn("token-rename", t.id, "pen", "Rename")}
        ${iconBtn("token-rotate", t.id, "rotate", "Replace with a new value")}
        ${iconBtn("token-delete", t.id, "trash", "Delete")}
      </div>
    </div>`;
  }).join("");

  return `<section class="card sc" id="sec-apple">
    ${secHead("apple", "Your Apple Watch saves to Apple Health on your iPhone; an app there sends it here. Steps, active calories, exercise minutes, workouts and weight fill in on their own. Food and sleep never come from Apple.")}
    ${status}
    ${row("Upload URL", "Paste this into Health Auto Export or your Shortcut.",
      `<div class="urlrow"><code>${esc(url)}</code><button type="button" class="btn" data-act="copy-text" data-v="${esc(url)}">Copy</button></div>`)}
    <h3>Upload tokens</h3>
    <p class="hint">Each token lets one app send data here — nothing else. Give each phone or app its own, so you can revoke one without touching the others.</p>
    <div class="toks">${tokens || `<div class="empty-row">No tokens yet.</div>`}</div>
    ${st.envToken ? `<p class="hint small">A token is also set in Railway as <code>INGEST_TOKEN</code>. It keeps working; delete the variable once your phone uses a token from this list.</p>` : ""}
    <form class="newtok" data-form="token">
      <span class="inp"><input name="name" placeholder="Name it, e.g. iPhone — Health Auto Export" maxlength="60" aria-label="New token name"></span>
      <button type="submit" class="btn primary">Create token</button>
    </form>
    <details class="howto"><summary>Set up Health Auto Export (recommended)</summary>
      <ol>
        <li>Install <b>Health Auto Export – JSON+CSV</b> on your iPhone and allow it to read Health.</li>
        <li>Automations → New → <b>REST API</b>. URL: the upload URL above. Add a header named <code>Authorization</code> with the value <code>Bearer</code>, a space, then a token from this list.</li>
        <li>Data type <b>Health Metrics</b>: Step Count, Active Energy, Apple Exercise Time, Weight &amp; Body Mass. Add a second automation for <b>Workouts</b>. (Food and sleep are ignored if sent — they're logged here by hand.)</li>
        <li>Export format <b>JSON</b>, Aggregate data <b>on</b>, Summarize by <b>Day</b>, date range <b>Last 7 days</b>, sync every hour.</li>
        <li>Tap <b>Manual export</b> once with a long date range to backfill your history.</li>
      </ol>
    </details>
    <details class="howto"><summary>Or use a free iOS Shortcut</summary>
      <ol>
        <li>Shortcuts → New shortcut. Add <b>Find Health Samples</b> for each metric (e.g. Steps, today, summed).</li>
        <li>Add a <b>Dictionary</b>: <code>date</code> = today as <code>yyyy-MM-dd</code>, then <code>steps</code>, <code>activeKcal</code>, <code>exerciseMin</code>, <code>weight</code>, <code>workout</code>.</li>
        <li><b>Get Contents of URL</b>: the upload URL, Method POST, header <code>Authorization: Bearer …</code>, Request Body JSON = the dictionary.</li>
        <li>Automation → Time of Day (e.g. 9pm daily) → run the shortcut.</li>
      </ol>
    </details>
  </section>`;
}

/** The provenance rules, and what the phone has actually been sending. */
function sourcesSection(ctx) {
  const seen = ctx.settings?.fieldsSeen;
  const rule = (name, from) => `<div class="rrow"><span>${name}</span><span class="rfrom">${from}</span></div>`;
  const metrics = seen ? Object.entries(seen.metrics || {}).sort((a, b) => Number(b[1].accepted) - Number(a[1].accepted) || b[1].samples - a[1].samples) : [];
  const wf = seen ? Object.entries(seen.workoutFields || {}).sort((a, b) => b[1] - a[1]) : [];
  return `<section class="card sc" id="sec-sources">
    ${secHead("sources", "Every number knows where it came from. Apple Health can only fill the metrics below it's allowed to — anything else it sends is dropped before it's stored.")}
    <div class="rules">
      <div><h3>Logged by you only</h3>
        ${rule("Food diary entries and their totals", '<span class="srcTag manual">Manual</span>')}
        ${rule("Calories, protein, carbs, fat, fiber", '<span class="srcTag manual">Manual</span>')}
        ${rule("Sleep (bedtime → wake)", '<span class="srcTag manual">Manual</span>')}
        ${rule("Lifts (sets × reps × weight)", '<span class="srcTag manual">Manual</span>')}
        ${rule("Creatine", '<span class="srcTag manual">Manual</span>')}
      </div>
      <div><h3>Apple Health allowed</h3>
        ${rule("Steps", '<span class="srcTag apple">Apple</span> or you')}
        ${rule("Active calories, exercise minutes", '<span class="srcTag apple">Apple</span> or you')}
        ${rule("Workouts", '<span class="srcTag apple">Apple</span> or a tick')}
        ${rule("Weight", 'You, else <span class="srcTag apple">Apple</span>')}
      </div>
    </div>
    <p class="hint small">Where both are allowed, a value you type for a day wins over Apple's for that day.</p>
    <details class="howto"${seen ? "" : " hidden"}><summary>What your phone has sent</summary>
      ${metrics.length ? `<table class="seen"><thead><tr><th>Apple metric</th><th>Samples</th><th></th></tr></thead><tbody>
        ${metrics.map(([name, m]) => `<tr><td><code>${esc(name)}</code></td><td>${fmtInt(m.samples)}</td><td>${m.accepted ? '<span class="srcTag apple">Used</span>' : '<span class="muted">Ignored</span>'}</td></tr>`).join("")}
      </tbody></table>` : ""}
      ${wf.length ? `<p class="hint small">Fields seen on ${fmtInt(seen.workouts || 0)} workouts: ${wf.map(([f, n]) => `<code>${esc(f)}</code> ${n}`).join(" · ")}</p>` : `<p class="hint small">No workouts received yet.</p>`}
    </details>
  </section>`;
}

/** Older food/sleep entries whose source was never recorded. */
function reviewSection(ctx) {
  if (ctx.state.demo) return "";
  const items = reviewItems(ctx.raw);
  if (!items.length) return "";
  const hand = items.filter((x) => x.savedByHand).length;
  const rows = items.slice(0, 200).map((x) => {
    const f = x.food;
    const food = Object.keys(f).length
      ? [f.kcal != null ? `${fmtInt(f.kcal)} kcal` : null, f.protein != null ? `${f.protein}g P` : null, f.carbs != null ? `${f.carbs}g C` : null, f.fat != null ? `${f.fat}g F` : null, f.fiber != null ? `${f.fiber}g fiber` : null].filter(Boolean).join(" · ")
      : "";
    const sleep = x.sleep ? `sleep ${x.sleep.bed}–${x.sleep.wake}` : "";
    return `<label class="rvrow"><input type="checkbox" name="keep" value="${x.key}"${x.savedByHand ? " checked" : ""}>
      <span class="rd">${esc(fmtDay(x.key))}</span><span class="rvv">${esc([food, sleep].filter(Boolean).join(" · "))}</span>
      ${x.savedByHand ? `<span class="srcTag manual" title="This day was saved from the log dialog at least once">Saved by hand</span>` : ""}</label>`;
  }).join("");
  return `<form class="card sc" id="sec-review" data-form="review">
    <header class="sh"><span class="si" style="--c:#EE9A55">${ICONS.data}</span>
      <div><h2>Review older entries</h2><p>${items.length} day${items.length === 1 ? "" : "s"} hold food or sleep values saved before sources were tracked, so some may be Apple Health's. They're excluded from every number until you decide. Tick the ones you logged yourself; the rest are set aside (kept in exports, never counted).</p></div></header>
    <div class="rvbar">
      <button type="button" class="btn" data-act="review-all" data-v="hand">Tick “saved by hand” (${hand})</button>
      <button type="button" class="btn" data-act="review-all" data-v="none">Untick all</button>
    </div>
    <div class="rvlist">${rows}</div>
    <div class="actions"><button type="submit" class="btn primary">Keep ticked, set aside the rest</button><span class="saved" data-saved hidden></span></div>
  </form>`;
}

function trainingSection(ctx) {
  const plan = ctx.g.plan;
  const saved = ctx.state.demo ? ctx.state.savedPlan : plan;
  const selects = WEEKDAYS.map((d) => `<label class="field"><span>${WEEKDAY_LABELS[d]}</span><span class="inp"><select name="${d}">${PLAN_TYPES.map((t) =>
    `<option value="${t}"${(plan?.days?.[d] || "rest") === t ? " selected" : ""}>${PLAN_LABELS[t]}</option>`).join("")}</select></span></label>`).join("");
  return `<form class="card sc" id="sec-training" data-form="plan">
    ${secHead("training", "The week you're aiming for. Planned rest days never count as a missed workout, and Training Consistency badges measure each week against this plan — moving a session to another day that week is fine.")}
    ${ctx.state.demo && !saved ? `<p class="hint small">Showing the sample plan. Save to make it yours.</p>` : ""}
    <div class="fields seven">${selects}</div>
    <div class="fields"><label class="field"><span>Plan applies from</span><span class="inp"><input type="date" name="since" value="${esc(plan?.since || "")}"></span></label></div>
    <p class="hint small">Weeks before this date aren't judged against the plan. Leave it empty to apply the plan to your whole history.</p>
    <div class="actions"><button class="btn primary" type="submit">Save plan</button>${saved ? `<button type="button" class="btn danger ghost" data-act="plan-clear">Remove plan</button>` : ""}<span class="saved" data-saved hidden></span></div>
  </form>`;
}

function foodSection(ctx) {
  const f = ctx.settings?.food;
  if (!f) return "";
  const keyField = (name, info, label, placeholder) => `<div class="keyrow">
      <label class="field"><span>${label}</span><span class="inp"><input type="password" name="${name}" autocomplete="off" spellcheck="false"
        placeholder="${esc(info.set ? `${info.preview} — ${info.source === "railway" ? "from Railway" : "saved here"}` : placeholder)}"></span></label>
      ${info.source === "settings" ? `<button type="button" class="btn danger ghost" data-act="foodkey-clear" data-k="${name}">Remove</button>` : ""}
    </div>`;
  const test = (id) => `<button type="button" class="btn" data-act="food-test" data-v="${id}">Test</button><span class="testres" data-test="${id}"></span>`;
  const status = (on, text) => `<span class="pstat${on ? " on" : ""}"><i></i>${text}</span>`;
  return `<form class="card sc" id="sec-food" data-form="foodapis">
    ${secHead("food", "Where food search looks, most trusted first. Every result says where its numbers came from, and nothing is saved until you confirm it. Keys are stored in your database, never shown in full, and take priority over Railway variables.")}
    <div class="provs">
      <div class="prov-s">
        <div class="ps-h"><b>1 · USDA FoodData Central</b>${status(true, f.usda.set ? "Your key" : "Shared demo key")}</div>
        <p>Branded foods are the manufacturer's own label data (shown as <span class="srcTag verified">Verified</span>); USDA's generic foods cover eggs, rice, chicken and the like (<span class="srcTag database">Database</span>). Free. The shared demo key allows only a few searches an hour — a free personal key allows about 1,000. <a href="${esc(f.usdaSignup)}" target="_blank" rel="noopener noreferrer">Get a free key ↗</a></p>
        ${keyField("usdaKey", f.usda, "API key", "Paste your data.gov key")}
        <div class="actions">${test("usda")}</div>
      </div>
      <div class="prov-s">
        <div class="ps-h"><b>2 · FatSecret</b> <span class="muted">optional</span>${status(f.fatsecretId.set && f.fatsecretSecret.set, f.fatsecretId.set && f.fatsecretSecret.set ? "Connected" : "Not set")}</div>
        <p>Adds brand and chain-restaurant foods (<span class="srcTag database">Database</span>). The free Basic plan allows 5,000 calls a day with attribution. FatSecret only answers servers whose IP address is on your key's allow-list, and Railway's outbound IP can change unless you enable static IPs.</p>
        <div class="fields two">${keyField("fatsecretId", f.fatsecretId, "Client ID", "Client ID")}${keyField("fatsecretSecret", f.fatsecretSecret, "Client secret", "Client secret")}</div>
        <div class="actions">${test("fatsecret")}</div>
      </div>
      <div class="prov-s">
        <div class="ps-h"><b>3 · Open Food Facts</b>${status(f.offEnabled, f.offEnabled ? "On" : "Off")}</div>
        <p>Community-entered packaged foods — wide coverage, uneven accuracy, so results say “check against your label”. Free, no key; the server keeps under its 10-searches-a-minute limit.</p>
        <div class="toggles"><label class="chk"><input type="checkbox" name="offEnabled"${f.offEnabled ? " checked" : ""}><i style="--c:#45B3C8"></i>Search Open Food Facts</label></div>
        <div class="actions">${test("off")}</div>
      </div>
      <div class="prov-s">
        <div class="ps-h"><b>4 · AI estimates</b> <span class="muted">last resort</span>${status(f.anthropic.set, f.anthropic.set ? "On" : "Off")}</div>
        <p>Only when you tap “Estimate with AI” — for things no database has, like a restaurant sandwich. Claude returns its best estimate with a confidence level, a calorie range and what it's based on; it's marked <span class="srcTag estimate">Estimated</span> everywhere and opens for you to check before anything is saved. Each estimate costs roughly a cent or two on your Anthropic account and is cached, so asking twice is free. If the model declines a request, it's retried on Anthropic's default fallback model.</p>
        ${keyField("anthropicKey", f.anthropic, "Anthropic API key", "sk-ant-…")}
        <label class="field"><span>Model</span><span class="inp"><select name="anthropicModel">${f.models.map((m) => `<option value="${esc(m.id)}"${m.id === f.model ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select></span></label>
        <div class="actions">${test("anthropic")}</div>
      </div>
    </div>
    <p class="hint small">Leave a key field empty to keep the key you have. Searches are cached for two weeks, and any food you log is saved to My foods, so repeat foods never need a lookup.</p>
    <div class="actions"><button type="submit" class="btn primary">Save lookup settings</button><span class="saved" data-saved hidden></span></div>
  </form>`;
}

function achievementsSection(ctx) {
  const overrides = ctx.state.achievements?.tiers || {};
  const days = ctx.days;
  const keys = Object.keys(days).filter((k) => k <= ctx.today).sort();
  const lifted = keys.filter((k) => days[k]?.lifts?.length);
  const rows = DEFAULT_CATALOG.map((c) => {
    const tiers = overrides[c.id] || c.tiers;
    return `<div class="tierrow">
      <div class="sl"><b>${esc(c.name)}</b><span>${esc(c.unit)} · default ${c.tiers.map((n) => n.toLocaleString("en-US")).join(", ")}</span></div>
      <div class="tierin">${tiers.map((n, i) => `<span class="inp"><input type="number" name="${c.id}-${i}" min="0" step="any" value="${n}" aria-label="${esc(c.name)} tier ${i + 1}"></span>`).join("")}</div>
    </div>`;
  }).join("");
  return `<form class="card sc" id="sec-achievements" data-form="tiers">
    ${secHead("achievements", "What each badge tier takes. Progress, unlocks and unlock dates recalculate from your data the moment you save.")}
    ${rows}
    <p class="hint small">${lifted.length ? `Iron so far: ${lifted.length} logged session${lifted.length === 1 ? "" : "s"}.` : "No lifting sets logged yet, so Iron's defaults are a starting point — adjust them once a few weeks of sets show your typical volume."} Each tier must be larger than the one before.</p>
    <div class="actions"><button type="submit" class="btn primary">Save thresholds</button><button type="button" class="btn" data-act="tiers-reset">Reset to defaults</button><span class="saved" data-saved hidden></span><span class="err" data-err hidden></span></div>
  </form>`;
}

function displaySection(ctx) {
  const p = ctx.state.prefs || {};
  return `<section class="card sc" id="sec-display">
    ${secHead("display", "How the dashboard opens. Saved to your account, so every device starts the same way.")}
    ${row("Weight chart range", "The window the weight journey opens on.", seg("weightRange", [["30", "30D"], ["90", "90D"], ["all", "All"]], p.weightRange))}
    ${row("Nutrition trend range", "Days shown on the nutrition trends chart.", seg("trendRange", [[7, "7D"], [30, "30D"], [90, "90D"]], p.trendRange))}
    ${row("Nutrition trend metric", "Which macro the trends chart shows first.", seg("trendMetric", ["calories", "protein", "carbs", "fat", "fiber"].map((m) => [m, METRICS[m].label]), p.trendMetric))}
    ${row("Sleep timeline", "Nights shown on the sleep chart.", seg("sleepN", [[7, "7 nights"], [14, "14 nights"]], p.sleepN))}
    ${row("Sample data", "Show made-up days until your first real day arrives, so the charts aren't empty.", toggle("showSample", p.showSample !== false, "Show sample data"))}
  </section>`;
}

function securitySection(ctx) {
  const st = ctx.settings || {};
  const pw = st.password || {};
  const where = pw.source === "settings" ? `Set here ${pw.updatedAt ? esc(ago(new Date(pw.updatedAt))) : ""}. Railway's <code>APP_PASSWORD</code> no longer signs in.`
    : pw.source === "railway" ? "Using <code>APP_PASSWORD</code> from Railway. Change it here and you'll never need Railway for it again."
    : "No password: anyone who can open this page can use it. Fine on your own computer; set one before going online.";
  return `<section class="card sc" id="sec-security">
    ${secHead("security", "Who can open the dashboard.")}
    ${row("Password", where, "")}
    <form class="pwform" data-form="password" autocomplete="on">
      <input type="text" name="username" value="ash-health" autocomplete="username" hidden>
      <div class="fields">
        ${pw.set ? `<label class="field"><span>Current password</span><span class="inp"><input type="password" name="current" autocomplete="current-password" required></span></label>` : ""}
        <label class="field"><span>New password</span><span class="inp"><input type="password" name="next" autocomplete="new-password" minlength="8" required></span></label>
        <label class="field"><span>Confirm new password</span><span class="inp"><input type="password" name="confirm" autocomplete="new-password" minlength="8" required></span></label>
      </div>
      <div class="actions"><button type="submit" class="btn primary">${pw.set ? "Change password" : "Set password"}</button><span class="saved" data-saved hidden></span><span class="err" data-err hidden></span></div>
    </form>
    ${pw.set ? row("Sign out other devices", "Ends every session except this one — use it if you signed in somewhere you shouldn't stay signed in.",
      `<button type="button" class="btn" data-act="revoke-sessions">Sign out others</button>`) : ""}
    ${ctx.state.open ? "" : row("Sign out", "Only this browser.", `<form method="post" action="/logout"><button class="btn" type="submit">Sign out</button></form>`)}
    <p class="hint small">Locked out? In Railway → Variables, add <code>PASSWORD_RESET</code> = <code>1</code> and redeploy: the password set here is cleared and <code>APP_PASSWORD</code> works again. Then remove the variable.</p>
  </section>`;
}

function dataSection(ctx) {
  const n = Object.keys(ctx.days).length;
  const where = ctx.settings?.storage === "postgres" ? "Postgres database on Railway" : "data/local.json on this computer";
  return `<section class="card sc" id="sec-data">
    ${secHead("data", ctx.state.demo ? "Showing sample days — nothing is stored yet." : `${n} day${n === 1 ? "" : "s"} stored.`)}
    <span class="saved" data-saved hidden></span>
    ${row("Stored in", esc(where), "")}
    ${row("Backup", "A JSON file of every day, your goals, saved foods, meals, rewards and training plan. Import replaces the stored days.",
      `<div class="actions"><button type="button" class="btn" data-act="export">Export</button>
        <label class="btn">Import<input type="file" accept="application/json,.json" id="importfile" hidden></label></div>`)}
    ${ctx.state.demo ? "" : row("Erase all days", "Removes every logged and synced day. Goals, tokens and settings stay.",
      `<button type="button" class="btn danger" data-act="reset">Erase…</button>`)}
  </section>`;
}

export function settings(ctx) {
  return `<div class="settingsgrid">
    ${overview(ctx)}
    ${goalsSection(ctx)}
    ${appleSection(ctx)}
    ${sourcesSection(ctx)}
    ${foodSection(ctx)}
    ${trainingSection(ctx)}
    ${achievementsSection(ctx)}
    ${displaySection(ctx)}
    ${securitySection(ctx)}
    ${dataSection(ctx)}
    ${reviewSection(ctx)}
  </div>`;
}

/* ── pages ─────────────────────────────────────────────────────────────── */

export const PAGES = {
  today: {
    title: "Today",
    render: (ctx) => `${pageHeader(ctx, "Today")}${demoBanner(ctx)}${reviewNudge(ctx)}
      <div class="grid top">${scoreCard(ctx)}<div class="topright">${nextUnlockCard(ctx)}${statCards(ctx)}</div></div>
      <div class="grid three">${calorieCard(ctx)}${macroCard(ctx)}${todayVsAvg(ctx)}</div>
      <div class="grid wide-right">${heatmap(ctx)}${streaksCard(ctx)}</div>
      <div class="grid wide-right">${weeklyReviewCard(ctx)}${consistencyCard(ctx)}</div>
      ${insightsCard(ctx)}
      <div class="grid wide-right">${goalJourney(ctx)}${weeklyWeightCard(ctx)}</div>`,
  },
  weight: {
    title: "Weight",
    render: (ctx) => `${pageHeader(ctx, "Weight", false)}${demoBanner(ctx)}
      ${weightJourney(ctx)}
      <div class="grid wide-right">${goalJourney(ctx)}${weeklyWeightCard(ctx)}</div>`,
  },
  nutrition: {
    title: "Nutrition",
    render: (ctx) => {
      const key = foodDay(ctx);
      return `${pageHeader(ctx, "Nutrition", false)}${demoBanner(ctx)}${reviewNudge(ctx)}
      <div class="grid three">${calorieCard(ctx, key)}${macroCard(ctx, key)}${dailySummaryCard(ctx, key)}</div>
      <div class="grid wide-right">${foodDiaryCard(ctx, key)}<div class="sidecol">${weeklyBudgetCard(ctx)}${todayVsAvg(ctx)}</div></div>
      ${nutritionTrends(ctx)}
      ${foodHistoryCard(ctx)}
      ${libraryCard(ctx)}`;
    },
  },
  fitness: {
    title: "Fitness",
    render: (ctx) => `${pageHeader(ctx, "Fitness", false)}${demoBanner(ctx)}
      <div class="grid wide-right">${activityCard(ctx)}${fitnessStatsCard(ctx)}</div>
      ${strengthCard(ctx)}
      ${workoutWeekCard(ctx)}
      <div class="grid wide-right">${exerciseWeeksCard(ctx)}${workoutMixCard(ctx)}</div>
      ${activityCalendar(ctx)}
      <div class="grid narrow-left">${stepsCard(ctx)}${recentWorkouts(ctx) || `<section class="card"><h2>Recent workouts</h2><div class="nodata">No workouts synced yet.</div></section>`}</div>`,
  },
  sleep: {
    title: "Sleep",
    render: (ctx) => `${pageHeader(ctx, "Sleep", false)}${demoBanner(ctx)}${reviewNudge(ctx)}
      ${sleepCard(ctx)}
      <p class="hint pagehint">Sleep comes only from what you log — Apple Watch sleep is never used. Add last night from <b>Log today</b>.</p>`,
  },
  achievements: {
    title: "Achievements",
    render: (ctx) => `${pageHeader(ctx, "Achievements", false)}${demoBanner(ctx)}${achievementsPage(ctx, ctx.fresh)}`,
  },
  calendar: {
    title: "Calendar",
    render: (ctx) => `${pageHeader(ctx, "Calendar", false)}${demoBanner(ctx)}${calendar(ctx)}`,
  },
  settings: {
    title: "Settings",
    render: (ctx) => `${pageHeader(ctx, "Settings", false)}${settings(ctx)}`,
  },
};
PAGES.activity = PAGES.fitness; // old links

/** The day the Nutrition page shows: the diary's chosen day, never the future. */
export const foodDay = (ctx) => (ctx.ui.foodDay && ctx.ui.foodDay <= ctx.today ? ctx.ui.foodDay : ctx.today);

/* ── measured charts ───────────────────────────────────────────────────── */

export const CHARTS = {
  pacing: (ctx, width) => pacingChart(pacingRows(ctx), { width, daily: ctx.g.kcalTarget, color: color("calories"), fmtDay }),
  weight: (ctx, width) => {
    const [a, b] = weightWindow(ctx);
    return weightChart(weightSeries(ctx.days, a, b), {
      width, goal: ctx.g.goalWeight, start: ctx.g.startWeight, fmtDay,
      height: width < 520 ? 260 : 330,
    });
  },
  trend: (ctx, width) => {
    const id = ctx.ui.trendMetric;
    const g = ctx.g;
    return trendChart(trendRows(ctx), {
      width, color: color(id),
      target: id === "calories" ? g.kcalTarget : g[id],
      zone: id === "calories" ? [g.kcalLow, g.kcalHigh] : null,
      unit: id === "calories" ? "kcal" : "g", fmtDay,
      fmtVal: (v) => fmtInt(v),
    });
  },
  sleep: (ctx, width) => {
    const list = nights(ctx, ctx.ui.sleepN);
    const logged = list.filter((x) => x.bed != null).length;
    // The target window appears once there's enough of your own sleep to compare against it.
    const target = logged >= MIN.sleep ? { bed: nightOffset(ctx.g.bedTarget), wake: nightOffset(ctx.g.wakeTarget) } : null;
    return sleepTimeline(list, { width, color: color("sleep"), fmtDay, fmtDur, fmtClock, targetMins: ctx.g.sleepHours * 60, target });
  },
  wweek: (ctx, width) => {
    const mon = addDays(mondayOf(ctx.today), ctx.ui.fitWeek * 7);
    const keys = range(mon, addDays(mon, 6));
    const byDay = Object.fromEntries(keys.map((k) => [k, ctx.days[k]?.workouts || []]));
    return workoutWeek(keys, byDay, { width, typeColor, fmtDay, today: ctx.today });
  },
  exweeks: (ctx, width) => {
    const mon = mondayOf(ctx.today);
    const rows = [];
    for (let i = 11; i >= 0; i--) {
      const a = addDays(mon, -7 * i), b = addDays(a, 6);
      const t = fitnessTotals(ctx.days, a, b > ctx.today ? ctx.today : b);
      rows.push({ key: a, v: t.exercise, current: i === 0, title: `Week of ${fmtDay(a, true)}`,
        sub: t.exercise == null ? "" : `${t.workouts} workout${t.workouts === 1 ? "" : "s"} · ${t.exerciseDays} day${t.exerciseDays === 1 ? "" : "s"} synced` });
    }
    return weekBars(rows, { width, color: color("exercise"), target: ctx.g.exerciseMin * 7,
      fmtLabel: (r, i) => (i % 2 === 0 || rows.length < 8 ? fmtDay(r.key, true) : "") });
  },
};

