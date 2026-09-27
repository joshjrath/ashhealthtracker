/* ──────────────────────────────────────────────────────────────────────────
   Every panel on the site, each a function of the context:
     ctx = { state, g, days, today, ui }
   Panels return HTML strings. Wide charts leave a [data-chart] slot that
   app.js fills at the slot's measured width (see CHARTS at the bottom).
   ────────────────────────────────────────────────────────────────────────── */
import {
  METRICS, GOAL_IDS, addDays, parseKey, range, mondayOf,
  goalMet, dayScore, streak, valueOf, average, weightSeries, goalProgress,
  weeklyWeight, macroCalories, sleepMinutes, nightOffset,
  fmtInt, fmt1, fmtK, fmtDur, fmtClock,
} from "./metrics.js";
import { esc, tip, ring, sparkline, weightChart, trendChart, miniBars, sleepTimeline } from "./charts.js";

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
const CHECK = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const OPEN = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const FLAME = `<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M8.2 1.5c.4 2.3-1.4 3.4-2.5 4.9C4.6 7.8 4 9 4 10.3 4 12.9 5.9 14.5 8 14.5s4-1.5 4-4.1c0-1.6-.8-2.8-1.6-3.6.1 1.2-.4 2.1-1.2 2.4.6-2.8-.2-5.8-1-7.7z" fill="currentColor"/></svg>`;

/** What the goal was measured at today, in words. */
function goalValue(id, day, g) {
  switch (id) {
    case "calories": return day?.kcal != null ? `${fmtInt(day.kcal)} kcal` : "—";
    case "protein": return day?.protein != null ? `${day.protein}g / ${g.protein}g` : "—";
    case "fiber": return day?.fiber != null ? `${day.fiber}g / ${g.fiber}g` : "—";
    case "steps": return day?.steps != null ? fmtInt(day.steps) : "—";
    case "sleep": return fmtDur(sleepMinutes(day));
    case "workout": return day?.workout == null ? "—" : day.workout ? "Done" : "Rest";
    case "creatine": return day?.creatine == null ? "—" : day.creatine ? "Taken" : "Missed";
    default: return "—";
  }
}

const tracked = (g) => g.tracked.filter((id) => GOAL_IDS.includes(id));

function tabs(act, options, current) {
  return `<div class="tabs" role="tablist">${options.map(([v, l]) =>
    `<button type="button" role="tab" class="tab${String(v) === String(current) ? " on" : ""}" aria-selected="${String(v) === String(current)}"
      data-act="${act}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
}

/* ── page chrome ───────────────────────────────────────────────────────── */

export function pageHeader(ctx, title, withGoals = true) {
  const s = dayScore(ctx.days[ctx.today], ctx.g);
  const segs = s.detail.map((x) => `<i class="${x.met ? "on" : ""}" style="--c:${color(x.id)}" title="${esc(METRICS[x.id].label)}"></i>`).join("");
  return `<header class="page">
    <div>
      <div class="eyebrow">${esc(fmtDay(ctx.today))}</div>
      <h1>${esc(title)}</h1>
    </div>
    ${withGoals ? `<div class="goalmeter" aria-label="${s.met} of ${s.total} goals complete today">
      <div class="gm-n"><b>${s.met}/${s.total}</b> goals complete</div>
      <div class="gm-segs">${segs}</div>
    </div>` : ""}
    <button type="button" class="btn primary" data-act="log" data-key="${ctx.today}">Log today</button>
  </header>`;
}

export function demoBanner(ctx) {
  if (!ctx.state.demo || ctx.ui.demoHidden) return "";
  return `<div class="banner">
    <span><b>Sample data.</b> Four months of made-up days so every chart has something to show.</span>
    <button type="button" class="btn" data-act="demo-hide">Keep exploring</button>
    <button type="button" class="btn light" data-act="demo-clear">Start my own log</button>
  </div>`;
}

/* ── 11 · daily score ──────────────────────────────────────────────────── */

export function scoreCard(ctx) {
  const day = ctx.days[ctx.today];
  const s = dayScore(day, ctx.g);
  const rows = s.detail.map((x) => `<li class="${x.met ? "met" : ""}">
      <span class="st">${x.met ? CHECK : OPEN}</span>
      <span class="nm">${esc(METRICS[x.id].label)}</span>
      <span class="v">${esc(goalValue(x.id, day, ctx.g))}</span>
    </li>`).join("");
  return `<section class="card score">
    <div class="lbl">Daily score</div>
    <div class="big">${Math.round(s.pct * 100)}<small>%</small></div>
    <div class="of">${s.met} / ${s.total} goals</div>
    <ul class="why">${rows}</ul>
  </section>`;
}

/* ── 1 · stat cards ────────────────────────────────────────────────────── */

export function statCards(ctx) {
  const { g, today } = ctx;
  const d = ctx.days[today] || {};
  const gp = goalProgress(ctx.days, g, today);
  const sleep = sleepMinutes(d);
  const cre = streak("creatine", ctx.days, g, today).current;
  const trend = weightSeries(ctx.days, addDays(today, -29), today).map((x) => x.avg);
  const card = (id, value, unit, sub, pct, met, extra = "", cls = "") => `<div class="stat${met ? " met" : ""}${cls}" style="--c:${color(id)}">
      <div class="txt">
        <div class="l">${esc(METRICS[id].label)}</div>
        <div class="n">${value}${unit ? `<small>${unit}</small>` : ""}</div>
        <div class="s">${sub}</div>
        ${extra}
      </div>
      <div class="r">${ring({ pct, size: 58, stroke: 6, color: color(id), label: `${METRICS[id].label} ${Math.round(pct * 100)}%` })}
        ${met ? `<span class="okdot">${CHECK}</span>` : ""}</div>
    </div>`;
  return `<section class="stats">
    ${card("weight", fmt1(gp.current), "lb", `${gp.lost >= 0 ? "−" : "+"}${fmt1(Math.abs(gp.lost))} lb since start · ${Math.round(gp.pct * 100)}% to goal`, gp.pct, false,
      sparkline(trend, { width: 300, height: 34, color: color("weight") }), " wide")}
    ${card("calories", fmtInt(d.kcal), "", `of ${fmtInt(g.kcalTarget)} kcal`, (d.kcal || 0) / g.kcalTarget, goalMet("calories", d, g))}
    ${card("protein", d.protein ?? "—", "g", `of ${g.protein}g`, (d.protein || 0) / g.protein, goalMet("protein", d, g))}
    ${card("steps", fmtInt(d.steps), "", `of ${fmtInt(g.steps)}`, (d.steps || 0) / g.steps, goalMet("steps", d, g))}
    ${card("sleep", esc(fmtDur(sleep)), "", `of ${g.sleepHours}h`, (sleep || 0) / (g.sleepHours * 60), goalMet("sleep", d, g))}
    ${card("workout", d.workout ? "Done" : "Not yet", "", d.workout ? "Logged today" : "Nothing logged", d.workout ? 1 : 0, goalMet("workout", d, g))}
    ${card("creatine", d.creatine ? "Taken" : "Not yet", "", `${cre}-day streak`, d.creatine ? 1 : 0, goalMet("creatine", d, g))}
  </section>`;
}

/* ── 3 · calorie ring ──────────────────────────────────────────────────── */

export function calorieCard(ctx) {
  const { g } = ctx;
  const d = ctx.days[ctx.today] || {};
  const k = d.kcal ?? 0;
  const inZone = k >= g.kcalLow && k <= g.kcalHigh;
  const status = !d.kcal ? `<span class="pill">Nothing logged</span>`
    : inZone ? `<span class="pill ok">${CHECK} In range</span>`
    : k < g.kcalLow ? `<span class="pill">${fmtInt(g.kcalLow - k)} to range</span>`
    : `<span class="pill warn">▲ Over by ${fmtInt(k - g.kcalHigh)}</span>`;
  return `<section class="card cal-card">
    <h2>Calories</h2>
    <div class="bigring">
      ${ring({ pct: k / g.kcalTarget, size: 232, stroke: 18, color: color("calories"),
        zone: [g.kcalLow / g.kcalTarget, g.kcalHigh / g.kcalTarget], label: `${k} of ${g.kcalTarget} kcal` })}
      <div class="center">
        <div class="n">${fmtInt(k)}</div>
        <div class="of">/ ${fmtInt(g.kcalTarget)} kcal</div>
        ${status}
      </div>
    </div>
    <div class="zonekey"><i style="--c:${color("calories")}"></i>Success zone ${fmtInt(g.kcalLow)}–${fmtInt(g.kcalHigh)} kcal, drawn at the top of the ring</div>
  </section>`;
}

/* ── 4 + 5 · macro rings and composition ───────────────────────────────── */

export function macroCard(ctx) {
  const { g } = ctx;
  const d = ctx.days[ctx.today] || {};
  const mini = (id, size, stroke) => {
    const v = d[id] ?? 0, t = g[id];
    return `<div class="macro ${id}">
      <div class="mring">${ring({ pct: v / t, size, stroke, color: color(id), label: `${METRICS[id].label} ${v} of ${t} g` })}
        <div class="center"><b>${v}</b><small>/ ${t}g</small></div></div>
      <div class="ml"><i style="--c:${color(id)}"></i>${esc(METRICS[id].label)}${id === "protein" ? `<span class="tag">Primary</span>` : ""}</div>
    </div>`;
  };
  const mc = macroCalories(d);
  const parts = ["protein", "carbs", "fat"].map((id) => ({ id, kcal: mc[id], g: d[id] ?? 0 }));
  const bar = mc.total
    ? parts.map((p) => `<span class="seg" style="flex:${p.kcal} 0 0;--c:${color(p.id)}" ${tip(METRICS[p.id].label, `${p.g}g · ${fmtInt(p.kcal)} kcal`, `${Math.round((p.kcal / mc.total) * 100)}% of calories`)}></span>`).join("")
    : `<span class="seg empty"></span>`;
  const legend = parts.map((p) => `<div><i style="--c:${color(p.id)}"></i><span class="nm">${esc(METRICS[p.id].label)}</span>
      <b>${p.g}g</b><span class="pc">${mc.total ? Math.round((p.kcal / mc.total) * 100) : 0}%</span></div>`).join("");
  return `<section class="card macros">
    <h2>Macros</h2>
    <div class="mrow">
      ${mini("protein", 132, 13)}
      <div class="sec">${mini("carbs", 86, 8)}${mini("fat", 86, 8)}</div>
    </div>
    <div class="comp">
      <div class="comp-h"><span>Calorie composition</span><span>${fmtInt(mc.total)} kcal from macros</span></div>
      <div class="compbar">${bar}</div>
      <div class="complegend">${legend}</div>
    </div>
  </section>`;
}

/* ── 15 · today vs average ─────────────────────────────────────────────── */

export function todayVsAvg(ctx) {
  const { days, today } = ctx;
  const a = addDays(today, -14), b = addDays(today, -1);
  const rows = [
    ["calories", (v) => fmtInt(v), "", 0],
    ["protein", (v) => `${Math.round(v)}g`, "", 1],
    ["fiber", (v) => `${Math.round(v)}g`, "", 1],
    ["steps", (v) => fmtK(v), "", 1],
    ["sleep", (v) => fmtDur(v), "", 1],
  ].map(([id, f, , better]) => {
    const t = valueOf(id, days[today]);
    const avg = average(id, days, a, b);
    if (t == null || avg == null) {
      return `<div class="tva"><span class="nm"><i style="--c:${color(id)}"></i>${esc(METRICS[id].label)}</span><span class="delta"></span>
        <span class="tv"><span class="t">${t == null ? "—" : esc(f(t))}</span><span class="avg">${avg == null ? "no baseline" : `vs ${esc(f(avg))} avg`}</span></span></div>`;
    }
    const diff = t - avg;
    const pct = avg ? diff / avg : 0;
    const good = better && diff > 0;
    const hi = Math.max(t, avg) * 1.15;
    const flat = Math.abs(pct) < 0.01;
    return `<div class="tva" ${tip(METRICS[id].label, `Today ${f(t)}`, `14-day avg ${f(avg)}`)}>
      <span class="nm"><i style="--c:${color(id)}"></i>${esc(METRICS[id].label)}</span>
      <span class="delta${flat ? "" : good ? " up" : ""}">${flat ? "=" : diff > 0 ? "↑" : "↓"} ${Math.abs(Math.round(pct * 100))}%</span>
      <span class="tv"><span class="t">${esc(f(t))}</span><span class="avg">vs ${esc(f(avg))} avg</span></span>
      <span class="bullet"><span class="fill" style="width:${((t / hi) * 100).toFixed(1)}%;--c:${color(id)}"></span><span class="avgtick" style="left:${((avg / hi) * 100).toFixed(1)}%"></span></span>
    </div>`;
  }).join("");
  return `<section class="card vsavg">
    <h2>Today vs average <span class="sub">last 14 days</span></h2>
    <div class="tvas">${rows}</div>
  </section>`;
}

/* ── 8 · weekly heatmap ────────────────────────────────────────────────── */

export function heatmap(ctx) {
  const { g, today, ui } = ctx;
  const mon = addDays(mondayOf(today), ui.heatWeek * 7);
  const keys = range(mon, addDays(mon, 6));
  const ids = tracked(g);
  const head = keys.map((k) => `<div class="hh${k === today ? " today" : ""}"><span>${WD[parseKey(k).getDay()]}</span><b>${parseKey(k).getDate()}</b></div>`).join("");
  const rows = ids.map((id) => `<div class="hl"><i style="--c:${color(id)}"></i>${esc(METRICS[id].label)}</div>` + keys.map((k) => {
    const future = k > today;
    const m = future ? null : goalMet(id, ctx.days[k], g);
    const cls = m === true ? "on" : m === false ? "miss" : "none";
    const state = m === true ? "Met" : m === false ? "Missed" : future ? "Upcoming" : "Not logged";
    return `<div class="hc ${cls}${k === today ? " today" : ""}" style="--c:${color(id)}" ${tip(`${METRICS[id].label} · ${fmtDay(k)}`, `${state}${m != null ? ` — ${goalValue(id, ctx.days[k], g)}` : ""}`)}>${m === true ? CHECK : ""}</div>`;
  }).join("")).join("");
  const foot = keys.map((k) => {
    if (k > today) return `<div class="hf"></div>`;
    const s = dayScore(ctx.days[k], g);
    if (!s.logged) return `<div class="hf">—</div>`;
    return `<div class="hf${s.met === s.total ? " perfect" : ""}">${s.met}/${s.total}</div>`;
  }).join("");
  const wkMet = keys.filter((k) => k <= today).reduce((n, k) => n + dayScore(ctx.days[k], g).met, 0);
  const wkPossible = keys.filter((k) => k <= today).length * ids.length;
  return `<section class="card heat">
    <div class="cardhead">
      <h2>Week at a glance <span class="sub">${esc(fmtDay(keys[0], true))} – ${esc(fmtDay(keys[6], true))} · ${wkMet}/${wkPossible} hit</span></h2>
      <div class="pager">
        <button type="button" class="nav" data-act="heat" data-v="-1" aria-label="Previous week">‹</button>
        <button type="button" class="nav" data-act="heat" data-v="0"${ui.heatWeek === 0 ? " disabled" : ""}>This week</button>
        <button type="button" class="nav" data-act="heat" data-v="1" aria-label="Next week"${ui.heatWeek >= 0 ? " disabled" : ""}>›</button>
      </div>
    </div>
    <div class="hgrid" style="--rows:${ids.length}">
      <div></div>${head}
      ${rows}
      <div class="hl foot">Score</div>${foot}
    </div>
  </section>`;
}

/* ── 13 · streaks ──────────────────────────────────────────────────────── */

export function streaksCard(ctx) {
  const list = tracked(ctx.g)
    .map((id) => ({ id, ...streak(id, ctx.days, ctx.g, ctx.today) }))
    .sort((a, b) => b.current - a.current || b.best - a.best);
  const rows = list.map((s) => `<div class="streak${s.current ? "" : " cold"}${s.current && s.current === s.best ? " record" : ""}" style="--c:${color(s.id)}">
      <span class="fl">${FLAME}</span>
      <span class="nm">${esc(METRICS[s.id].label)}</span>
      <span class="cur"><b>${s.current}</b> day${s.current === 1 ? "" : "s"}</span>
      <span class="best">${s.current && s.current === s.best ? "Personal best" : `Best ${s.best}`}</span>
      <span class="sbar"><span style="width:${s.best ? ((s.current / s.best) * 100).toFixed(1) : 0}%"></span></span>
    </div>`).join("");
  return `<section class="card streaks"><h2>Streaks</h2><div class="slist">${rows}</div></section>`;
}

/* ── 7 · goal journey ──────────────────────────────────────────────────── */

export function goalJourney(ctx) {
  const gp = goalProgress(ctx.days, ctx.g, ctx.today);
  const span = gp.start - gp.goal;
  const ticks = [];
  if (span > 0) {
    for (let w = Math.floor(gp.start / 5) * 5; w > gp.goal; w -= 5) {
      if (w >= gp.start) continue;
      const p = (gp.start - w) / span;
      ticks.push(`<span class="jt${gp.current <= w ? " passed" : ""}" style="left:${(p * 100).toFixed(2)}%"><em>${w}</em></span>`);
    }
  }
  const pct = gp.pct * 100;
  return `<section class="card journey">
    <div class="cardhead"><h2>Goal journey</h2><span class="pct"><b>${pct.toFixed(1)}%</b> complete</span></div>
    <div class="jwrap">
      <div class="jtrack">
        <div class="jfill" data-anim-w="${pct.toFixed(2)}"></div>
        ${ticks.join("")}
        <div class="jmark" data-anim-left="${pct.toFixed(2)}"><span class="jnow">${fmt1(gp.current)}<small>lb</small></span></div>
      </div>
      <div class="jends">
        <div><b>${fmt1(gp.start)} lb</b><span>Start</span></div>
        <div class="r"><b>${fmt1(gp.goal)} lb</b><span>Goal</span></div>
      </div>
    </div>
    <div class="jstats">
      <div><span>Lost</span><b>${fmt1(gp.lost)}<small>lb</small></b></div>
      <div><span>Remaining</span><b>${fmt1(Math.max(0, gp.remaining))}<small>lb</small></b></div>
      <div><span>Complete</span><b>${Math.round(pct)}<small>%</small></b></div>
    </div>
  </section>`;
}

/* ── 6 · weekly weight trend ───────────────────────────────────────────── */

export function weeklyWeightCard(ctx) {
  const w = weeklyWeight(ctx.days, ctx.today);
  const ch = w.change;
  const dir = ch == null ? "" : ch < -0.05 ? "down" : ch > 0.05 ? "up" : "flat";
  const line = ch == null ? "Not enough weigh-ins yet"
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

/* ── 9 · steps ─────────────────────────────────────────────────────────── */

export function stepsCard(ctx) {
  const { g, today } = ctx;
  const s = ctx.days[today]?.steps ?? 0;
  const avg7 = average("steps", ctx.days, addDays(today, -6), today);
  const rows = range(addDays(today, -6), today).map((k) => ({ key: k, v: valueOf("steps", ctx.days[k]), today: k === today }));
  return `<section class="card steps">
    <h2>Steps</h2>
    <div class="bigring sm">
      ${ring({ pct: s / g.steps, size: 184, stroke: 15, color: color("steps"), label: `${s} of ${g.steps} steps` })}
      <div class="center"><div class="n">${fmtInt(s)}</div><div class="of">of ${fmtInt(g.steps)}</div></div>
    </div>
    <div class="stepmeta"><span>7-day average</span><b>${fmtInt(avg7)}</b></div>
    ${miniBars(rows, { color: color("steps"), target: g.steps, fmtDay })}
  </section>`;
}

/* ── 10 · sleep ────────────────────────────────────────────────────────── */

function nights(ctx, n) {
  return range(addDays(ctx.today, -(n - 1)), ctx.today).map((k) => {
    const d = ctx.days[k];
    return { key: k, bed: nightOffset(d?.bed), wake: nightOffset(d?.wake), mins: sleepMinutes(d), today: k === ctx.today };
  });
}

export function sleepCard(ctx) {
  const list = nights(ctx, ctx.ui.sleepN).filter((x) => x.bed != null);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const beds = list.map((x) => x.bed), wakes = list.map((x) => x.wake);
  const mb = mean(beds);
  const spread = beds.length > 1 ? Math.sqrt(mean(beds.map((b) => (b - mb) ** 2))) : null;
  return `<section class="card sleepc">
    <div class="cardhead"><h2>Sleep</h2>${tabs("sleep-n", [[7, "7 nights"], [14, "14 nights"]], ctx.ui.sleepN)}</div>
    <div class="sleepstats">
      <div><span>Average</span><b>${esc(fmtDur(mean(list.map((x) => x.mins))))}</b></div>
      <div><span>Avg bedtime</span><b>${esc(fmtClock(mb))}</b></div>
      <div><span>Avg wake</span><b>${esc(fmtClock(mean(wakes)))}</b></div>
      <div><span>Bedtime spread</span><b>${spread == null ? "—" : `±${Math.round(spread)}m`}</b></div>
    </div>
    <div class="chartbox" data-chart="sleep"></div>
  </section>`;
}

/* ── 2 · weight journey ────────────────────────────────────────────────── */

function weightWindow(ctx) {
  const keys = Object.keys(ctx.days).filter((k) => k <= ctx.today).sort();
  const first = keys[0] || ctx.today;
  const r = ctx.ui.weightRange;
  const a = r === "all" ? first : addDays(ctx.today, -(Number(r) - 1));
  return [a < first ? first : a, ctx.today];
}

export function weightJourney(ctx) {
  const gp = goalProgress(ctx.days, ctx.g, ctx.today);
  const [a, b] = weightWindow(ctx);
  const series = weightSeries(ctx.days, a, b).filter((s) => s.v != null).reverse();
  const rows = series.map((s) => `<tr><td>${esc(fmtDay(s.key))}</td><td>${s.v.toFixed(1)}</td><td>${s.avg != null ? s.avg.toFixed(1) : "—"}</td></tr>`).join("");
  return `<section class="card wj">
    <div class="cardhead">
      <h2>Weight journey</h2>
      ${tabs("weight-range", [[30, "30D"], [90, "90D"], ["all", "All"]], ctx.ui.weightRange)}
    </div>
    <div class="wjstats">
      <div><span>Current</span><b>${fmt1(gp.current)}<small>lb</small></b></div>
      <div class="arrow" aria-hidden="true">→</div>
      <div><span>Total lost</span><b>${fmt1(gp.lost)}<small>lb</small></b></div>
      <div class="arrow" aria-hidden="true">→</div>
      <div><span>Remaining</span><b>${fmt1(Math.max(0, gp.remaining))}<small>lb</small></b></div>
      <div class="arrow" aria-hidden="true">→</div>
      <div class="hl"><span>Goal progress</span><b>${Math.round(gp.pct * 100)}<small>%</small></b></div>
    </div>
    <div class="chartbox" data-chart="weight"></div>
    <div class="legend">
      <span><i class="dotkey"></i>Daily weigh-in</span>
      <span><i class="linekey"></i>7-day average</span>
      <span><i class="goalkey"></i>Goal ${fmt1(ctx.g.goalWeight)} lb</span>
    </div>
    <details class="datatable"><summary>Show data</summary>
      <table><thead><tr><th>Day</th><th>Weigh-in</th><th>7-day avg</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
  </section>`;
}

/* ── 14 · nutrition trends ─────────────────────────────────────────────── */

const TREND_METRICS = ["calories", "protein", "carbs", "fat", "fiber"];

function trendRows(ctx) {
  const { ui, g } = ctx;
  const id = ui.trendMetric;
  return range(addDays(ctx.today, -(ui.trendRange - 1)), ctx.today).map((k) => {
    const v = valueOf(id, ctx.days[k]);
    let met = null;
    if (v != null) {
      if (id === "calories") met = v >= g.kcalLow && v <= g.kcalHigh;
      else if (id === "carbs" || id === "fat") met = v <= g[id] * 1.1 && v >= g[id] * 0.8;
      else met = v >= g[id];
    }
    return { key: k, v, met };
  });
}

export function nutritionTrends(ctx) {
  const { ui, g } = ctx;
  const id = ui.trendMetric;
  const rows = trendRows(ctx);
  const logged = rows.filter((r) => r.v != null);
  const avg = logged.length ? logged.reduce((s, r) => s + r.v, 0) / logged.length : null;
  const on = logged.filter((r) => r.met).length;
  const unit = id === "calories" ? "kcal" : "g";
  const targetText = id === "calories" ? `${fmtInt(g.kcalLow)}–${fmtInt(g.kcalHigh)} kcal`
    : id === "carbs" || id === "fat" ? `~${g[id]}g` : `≥ ${g[id]}g`;
  const table = [...rows].reverse().map((r) => `<tr><td>${esc(fmtDay(r.key))}</td><td>${r.v == null ? "—" : fmtInt(r.v)}</td><td>${r.met == null ? "" : r.met ? "✓" : "○"}</td></tr>`).join("");
  return `<section class="card trends">
    <div class="cardhead">
      <h2>Nutrition trends</h2>
      ${tabs("trend-range", [[7, "7D"], [30, "30D"], [90, "90D"]], ui.trendRange)}
    </div>
    ${tabs("trend-metric", TREND_METRICS.map((m) => [m, METRICS[m].label]), id)}
    <div class="trstats">
      <div><span>Average</span><b>${fmtInt(avg)}<small>${unit}</small></b></div>
      <div><span>Target</span><b class="t">${esc(targetText)}</b></div>
      <div><span>Days on target</span><b>${on}<small>/ ${logged.length}</small></b></div>
    </div>
    <div class="chartbox" data-chart="trend"></div>
    <div class="legend">
      <span><i class="dotkey" style="--c:${color(id)}"></i>On target</span>
      <span><i class="dotkey off" style="--c:${color(id)}"></i>Off target</span>
      <span><i class="linekey" style="--c:${color(id)}"></i>7-day average</span>
      <span><i class="${id === "calories" ? "zonekey2" : "goalkey"}" style="--c:${color(id)}"></i>${id === "calories" ? "Success zone" : "Target"}</span>
    </div>
    <details class="datatable"><summary>Show data</summary>
      <table><thead><tr><th>Day</th><th>${esc(METRICS[id].label)} (${unit})</th><th>Target</th></tr></thead><tbody>${table}</tbody></table>
    </details>
  </section>`;
}

/* ── 12 · calendar ─────────────────────────────────────────────────────── */

/** Tint for a day's score. Most days land 4–7 of 7, so the ramp spends its range there. */
const shade = (pct) => (0.03 + Math.pow(Math.max(0, (pct - 0.3) / 0.7), 1.6) * 0.42).toFixed(3);

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
    const s = dayScore(d, g);
    const has = d && s.logged && !future;
    const cls = ["cell", inMonth ? "" : "outside", k === today ? "today" : "", future ? "future" : "",
      has && s.met === s.total ? "perfect" : ""].filter(Boolean).join(" ");
    const body = has ? `<div class="cs">
        <span class="sc">${s.met}/${s.total}${s.met === s.total ? ` ${CHECK}` : ""}</span>
        <span><b>${fmtInt(d.kcal)}</b> kcal</span>
        <span><b>${d.protein ?? "—"}g</b> protein</span>
        <span><b>${fmtK(d.steps)}</b> steps</span>
        ${d.weight != null ? `<span><b>${fmt1(d.weight)}</b> lb</span>` : ""}
      </div>` : "";
    return `<button type="button" class="${cls}" style="--a:${has ? shade(s.pct) : 0}"
        data-act="log" data-key="${k}"${future ? " disabled" : ""}
        aria-label="${esc(fmtDay(k))}${has ? `, ${s.met} of ${s.total} goals` : ""}">
      <span class="num">${parseKey(k).getDate()}${k === today ? `<span class="tag">Today</span>` : ""}</span>${body}</button>`;
  }).join("");
  const scale = [0.4, 0.55, 0.7, 0.85, 1].map((p) => `<i style="--a:${shade(p)}"></i>`).join("");
  return `<section class="calwrap">
    <div class="calbar">
      <div class="month">${MONTHS_LONG[m]} ${y}</div>
      <button type="button" class="nav" data-act="cal" data-v="-1">‹ Prev</button>
      <button type="button" class="nav" data-act="cal" data-v="0"${ui.calMonth === 0 ? " disabled" : ""}>Today</button>
      <button type="button" class="nav" data-act="cal" data-v="1"${ui.calMonth >= 0 ? " disabled" : ""}>Next ›</button>
      <div class="calscale"><span>Fewer goals</span>${scale}<span>All goals</span></div>
    </div>
    <div class="cal">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => `<div class="wd">${w}</div>`).join("")}
      ${cells}
    </div>
  </section>`;
}

/* ── settings ──────────────────────────────────────────────────────────── */

export function settings(ctx) {
  const { g } = ctx;
  const num = (name, label, value, step = 1, unit = "") => `<label class="field"><span>${esc(label)}</span>
    <span class="inp"><input type="number" name="${name}" value="${esc(value)}" step="${step}" min="0" required>${unit ? `<em>${esc(unit)}</em>` : ""}</span></label>`;
  const checks = GOAL_IDS.map((id) => `<label class="chk"><input type="checkbox" name="tracked" value="${id}"${g.tracked.includes(id) ? " checked" : ""}><i style="--c:${color(id)}"></i>${esc(METRICS[id].label)}</label>`).join("");
  const n = Object.keys(ctx.days).length;
  return `<form class="card settings" id="goalsform">
      <h2>Weight goal</h2>
      <div class="fields">${num("startWeight", "Starting weight", g.startWeight, 0.1, "lb")}${num("goalWeight", "Goal weight", g.goalWeight, 0.1, "lb")}</div>
      <h2>Daily targets</h2>
      <div class="fields">
        ${num("kcalTarget", "Calorie target", g.kcalTarget, 10, "kcal")}
        ${num("kcalLow", "Success zone from", g.kcalLow, 10, "kcal")}
        ${num("kcalHigh", "Success zone to", g.kcalHigh, 10, "kcal")}
        ${num("protein", "Protein", g.protein, 1, "g")}
        ${num("carbs", "Carbs", g.carbs, 1, "g")}
        ${num("fat", "Fat", g.fat, 1, "g")}
        ${num("fiber", "Fiber", g.fiber, 1, "g")}
        ${num("steps", "Steps", g.steps, 100)}
        ${num("sleepHours", "Sleep", g.sleepHours, 0.25, "h")}
      </div>
      <h2>Goals in the daily score</h2>
      <div class="checks">${checks}</div>
      <div class="actions"><button class="btn primary" type="submit">Save goals</button><span class="saved" id="savedmsg" hidden>Saved</span></div>
    </form>
    <section class="card settings">
      <h2>Your data</h2>
      <p class="hint">${n} day${n === 1 ? "" : "s"} logged${ctx.state.demo ? " (sample data)" : ""}. Everything lives in this browser — export a copy to move it or keep a backup.</p>
      <div class="actions">
        <button type="button" class="btn" data-act="export">Export JSON</button>
        <label class="btn">Import JSON<input type="file" accept="application/json,.json" id="importfile" hidden></label>
        ${ctx.state.demo ? `<button type="button" class="btn light" data-act="demo-clear">Clear sample data</button>` : `<button type="button" class="btn danger" data-act="reset">Erase all days</button>`}
      </div>
    </section>`;
}

/* ── pages ─────────────────────────────────────────────────────────────── */

export const PAGES = {
  today: {
    title: "Today",
    render: (ctx) => `${pageHeader(ctx, "Today")}${demoBanner(ctx)}
      <div class="grid top">${scoreCard(ctx)}${statCards(ctx)}</div>
      <div class="grid three">${calorieCard(ctx)}${macroCard(ctx)}${todayVsAvg(ctx)}</div>
      <div class="grid wide-right">${heatmap(ctx)}${streaksCard(ctx)}</div>
      <div class="grid wide-right">${goalJourney(ctx)}${weeklyWeightCard(ctx)}</div>
      <div class="grid narrow-left">${stepsCard(ctx)}${sleepCard(ctx)}</div>`,
  },
  weight: {
    title: "Weight",
    render: (ctx) => `${pageHeader(ctx, "Weight", false)}${demoBanner(ctx)}
      ${weightJourney(ctx)}
      <div class="grid wide-right">${goalJourney(ctx)}${weeklyWeightCard(ctx)}</div>`,
  },
  nutrition: {
    title: "Nutrition",
    render: (ctx) => `${pageHeader(ctx, "Nutrition", false)}${demoBanner(ctx)}
      <div class="grid three">${calorieCard(ctx)}${macroCard(ctx)}${todayVsAvg(ctx)}</div>
      ${nutritionTrends(ctx)}`,
  },
  activity: {
    title: "Activity & sleep",
    render: (ctx) => `${pageHeader(ctx, "Activity & sleep", false)}${demoBanner(ctx)}
      <div class="grid narrow-left">${stepsCard(ctx)}${sleepCard(ctx)}</div>
      <div class="grid wide-right">${heatmap(ctx)}${streaksCard(ctx)}</div>`,
  },
  calendar: {
    title: "Calendar",
    render: (ctx) => `${pageHeader(ctx, "Calendar", false)}${demoBanner(ctx)}${calendar(ctx)}`,
  },
  settings: {
    title: "Goals & data",
    render: (ctx) => `${pageHeader(ctx, "Goals & data", false)}${settings(ctx)}`,
  },
};

/* ── measured charts ───────────────────────────────────────────────────── */

export const CHARTS = {
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
  sleep: (ctx, width) => sleepTimeline(nights(ctx, ctx.ui.sleepN), {
    width, color: color("sleep"), fmtDay, fmtDur, fmtClock, targetMins: ctx.g.sleepHours * 60,
  }),
};

