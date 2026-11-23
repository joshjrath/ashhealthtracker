/* ──────────────────────────────────────────────────────────────────────────
   The "Am I On Track?" page: a status, where you're likely to be in 1 / 3 /
   6 / 12 months, when each body-fat milestone is likely, a chart of the
   projection against what's actually happened, a what-if panel, and what
   would help most. The model is js/forecast.js; the inputs come from the
   energy, body composition and strength analyses, so it updates whenever
   your logs do.
   ────────────────────────────────────────────────────────────────────────── */
import { energyOf } from "./energyview.js";
import { bodyOf } from "./bodyview.js";
import { startingPoint, scenarioInputs, project, onTrack, backtest, leanFactor, pairedSooner, pairedLean } from "./forecast.js";
import { weightAt, carryBodyFat } from "./bodycomp.js";
import { intakeFloor } from "./profile.js";
import { esc, tip } from "./charts.js";
import { fmtInt, addDays } from "./metrics.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOf = (k) => { const [y, m] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const dayShort = (k) => { const [, m, d] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
const STATUS_CLS = { on: "ok", ahead: "ok", slow: "mid", fast: "bad", insufficient: "none" };
const HORIZONS = [[30, "1 month"], [91, "3 months"], [182, "6 months"], [365, "1 year"]];
const KG = 0.45359237;

/** Everything the page needs, worked out once per draw. */
export function forecastOf(ctx) {
  if (ctx._fc !== undefined) return ctx._fc;
  const e = energyOf(ctx), b = bodyOf(ctx);
  const start = startingPoint({ energy: e.energy, trend: e.trend, intake: e.intake, bf: b.bf, strength: e.strength, recovery: e.strength?.recovery, g: ctx.g, weight: e.weight, days: ctx.days, today: ctx.today });
  if (!start) { ctx._fc = null; return null; }
  const floor = e.advice?.floor ?? intakeFloor(ctx.g, null);
  const milestones = [...new Set([15, 12, 10, start.target])].filter((m) => m < start.bodyFat).sort((x, y) => y - x);
  const goalWeight = start.goalWeight && start.goalWeight < start.weight ? start.goalWeight : null;
  const opts = { milestones, goalWeight };
  const baseIn = scenarioInputs(start, { floor });
  const proj = project(baseIn, { ...opts, runs: 80 });
  const status = onTrack(start, proj, ctx.today);
  const bt = backtest({ days: ctx.days, today: ctx.today, energy: e.energy, bodyFatNow: b.bf?.pct ?? null, weightAt, carry: carryBodyFat });
  const sc = ctx.ui.fc && Object.keys(ctx.ui.fc).length ? { ...ctx.ui.fc, floor } : null;
  const scIn = sc ? scenarioInputs(start, sc) : null;
  // comparisons (what-if, what would help) pair runs with a 40-run baseline sharing their random draws
  const base40 = project(baseIn, { ...opts, runs: 40 });
  const scProj = scIn ? project(scIn, { ...opts, runs: 40 }) : null;
  ctx._fc = { start, baseIn, proj, base40, status, bt, floor, milestones, goalWeight, opts, sc, scIn, scProj, e, b };
  ctx._fc.recs = recommendations(ctx._fc);
  return ctx._fc;
}

const when = (today, d) => (d == null ? null : d === 0 ? "now" : monthOf(addDays(today, d)));
const range3 = (a, b, c, f) => `${f(b)} <em>(${f(a)}–${f(c)})</em>`;

/** How much of the weight lost over six months is lean tissue, and what that suggests. */
function retention(sim, start) {
  const d = Math.min(182, sim.w.length - 1);
  const lost = sim.w[0] - sim.w[d], leanLost = sim.lean[0] - sim.lean[d];
  const share = lost > 0.5 ? leanLost / lost : 0;
  let id = share < 0.2 ? "good" : share < 0.35 ? "fair" : "risk";
  if (start.strength === "declining" && id === "good") id = "fair";
  return { share, leanLost, id, word: { good: "Good", fair: "Fair", risk: "At risk" }[id] };
}

/* ── the status ────────────────────────────────────────────────────────── */

export function statusCard(ctx) {
  const fc = forecastOf(ctx);
  if (!fc) return `<section class="card"><h2>Am I on track?</h2><div class="nodata">Log a few weigh-ins and complete food days, and this page projects where you're heading.</div></section>`;
  const { start, proj, status } = fc;
  const r = retention(proj.central, start);
  const deficit = start.tdee - start.intakeNow;
  const cell = (label, value, note, t) => `<div><span>${label}${t ? ` <span class="etag ${t}">${{ est: "Estimated", logged: "Logged", measured: "Measured trend" }[t]}</span>` : ""}</span><b>${value}</b><em>${note}</em></div>`;
  const rows = HORIZONS.map(([d, label]) => {
    const w = proj.w, bf = proj.bf;
    const fatLost = proj.central.fat[0] - proj.central.fat[d], lean = proj.central.lean[d] - proj.central.lean[0];
    return `<div class="fch"><b>${label}</b><span>${monthOf(addDays(ctx.today, d))}</span>
      <span class="fch-v">${range3(w.p10[d], w.p50[d], w.p90[d], (v) => `${v.toFixed(1)} lb`)}</span>
      <span class="fch-v">${range3(bf.p10[d], bf.p50[d], bf.p90[d], (v) => `${v.toFixed(1)}%`)}</span>
      <span>${fatLost >= 0 ? "−" : "+"}${Math.abs(fatLost).toFixed(1)} lb fat · ${lean >= 0 ? "+" : "−"}${Math.abs(lean).toFixed(1)} lb lean</span></div>`;
  }).join("");
  const bfNote = start.bodyFatKind === "readings" ? `±${start.bodyFatErr.toFixed(1)}` : start.bodyFatKind === "bmi" ? "rough, from BMI" : start.bodyFatKind === "settings" ? "your estimate" : "assumed — log a reading";
  return `<section class="card energycard fcstatus" id="ontrack">
    <div class="fcs-head">
      <div><span class="ea-l">Am I on track?</span><h2 class="fcs-word ${STATUS_CLS[status.id]}">${esc(status.word)}</h2><p>${esc(status.text)}</p></div>
      <span class="epill ${STATUS_CLS[status.id]}">${esc(status.word)}</span>
    </div>
    <div class="fgrid four ekpis">
      ${cell("Now", `${start.weight.toFixed(1)}<small>lb</small>`, `${start.bodyFat.toFixed(1)}% body fat (${bfNote})`, "measured")}
      ${cell("Pace", start.ratePct == null ? "—" : `${start.ratePct <= 0 ? "−" : "+"}${Math.abs(start.ratePct).toFixed(2)}<small>%/wk</small>`, `planned ${start.phase === "cut" ? `−${start.pace.toFixed(2)}%` : start.phase} · 28-day trend`, "measured")}
      ${cell("Daily deficit", `${deficit >= 0 ? "≈" : "+"}${fmtInt(Math.abs(deficit))}<small>kcal</small>`, `maintenance ~${fmtInt(start.tdee)} − eating ~${fmtInt(start.intakeNow)}`, "est")}
      ${cell("Muscle outlook", r.word, start.ratePct != null && proj.central.w[0] - proj.central.w[182] > 0.5 ? `~${Math.round(r.share * 100)}% of the next 6 months' loss projected as lean · ${start.sessions.toFixed(1)} lifts/wk, ${start.protein != null ? `${start.protein.toFixed(1)} g/kg protein` : "protein not logged"}` : "", "est")}
    </div>
    <div class="sec-l">Where you're likely to be <span class="sub">middle estimate, with the likely range (10th–90th percentile)</span></div>
    <div class="fchs"><div class="fch head"><b></b><span></span><span>Weight</span><span>Body fat</span><span>Change from now</span></div>${rows}</div>
    <p class="hint small">If you keep eating about ${fmtInt(start.intakeNow)} kcal a day (your recent average on complete days)${fc.baseIn.maintainAt != null ? `, then switch to maintenance on reaching ${start.target}%` : ""}. As you get lighter you burn less, so the loss slows — this is not a straight line. ${start.confidence === "developing" ? "Maintenance is still being calibrated, so the ranges are wide." : ""}</p>
  </section>`;
}

/* ── milestones ────────────────────────────────────────────────────────── */

export function milestonesCard(ctx) {
  const fc = forecastOf(ctx);
  if (!fc) return "";
  const { proj, start } = fc;
  const items = [
    ...proj.milestones.map((m) => ({ ...m, label: `${m.bf}% body fat`, at: m.median != null ? proj.central.w[Math.min(m.median, proj.days - 1)] : null, key: `bf${m.bf}`, main: m.bf === start.target })),
    ...(proj.goal ? [{ ...proj.goal, label: `${proj.goal.weight} lb goal weight`, key: "goal" }] : []),
  ];
  if (!items.length) return `<section class="card"><h2>Milestones</h2><p class="hint">You're already at or under ${start.target}% body fat by the current estimate — the forecast becomes about holding it. Consider switching your phase to maintenance.</p></section>`;
  const span = Math.max(365, ...items.map((i) => (i.late ?? i.median ?? 0) + 30));
  const x = (d) => Math.min(100, (d / span) * 100);
  const marks = items.filter((i) => i.median != null).map((i) => `<span class="fcm${i.main ? " main" : ""}" style="left:${x(i.median).toFixed(1)}%" ${tip(i.label, `around ${when(ctx.today, i.median)}`, i.late != null ? `likely ${when(ctx.today, i.early)} – ${when(ctx.today, i.late)}` : "")}><i></i><b>${esc(i.key === "goal" ? `${i.weight} lb` : `${i.bf}%`)}</b></span>`).join("");
  const bands = items.filter((i) => i.median != null).map((i) => `<span class="fcb${i.main ? " main" : ""}" style="left:${x(i.early ?? i.median).toFixed(1)}%;width:${Math.max(0.6, x(i.late ?? span) - x(i.early ?? i.median)).toFixed(1)}%"></span>`).join("");
  const ticks = [0, 91, 182, 365, 730, 1095].filter((d) => d <= span).map((d) => `<span class="fct" style="left:${x(d).toFixed(1)}%">${d === 0 ? "Now" : monthOf(addDays(ctx.today, d))}</span>`).join("");
  const rows = items.map((i) => `<div class="fcr${i.main ? " main" : ""}"><b>${esc(i.label)}</b>
      <span>${i.median == null ? (i.share > 0 ? `reached in only ${Math.round(i.share * 100)}% of runs within 3 years at this intake` : "not reached at this intake") : i.median === 0 ? "possibly already there" : `around <b>${when(ctx.today, i.median)}</b>${i.at ? ` at ~${fmtInt(i.at)} lb` : ""}`}</span>
      <em>${i.median != null ? `likely ${when(ctx.today, i.early)} – ${i.late != null ? when(ctx.today, i.late) : "later than 3 years"}` : ""}</em></div>`).join("");
  return `<section class="card fcmiles">
    <div class="cardhead"><h2>Milestones <span class="sub">when each is likely, at your current intake</span></h2></div>
    <div class="fctl"><div class="fctl-bar">${bands}${marks}</div><div class="fctl-ticks">${ticks}</div></div>
    <div class="fcrs">${rows}</div>
    ${start.bodyFatKind !== "readings" ? `<p class="hint small">Body-fat milestones are rough until you log a reading or your waist and neck (Weight page → Log measurements).</p>` : ""}
    ${proj.goal && proj.goal.median == null && proj.milestones.some((m) => m.bf === start.target && m.median != null) ? `<p class="hint small">Your goal weight may sit below where ${start.target}% lands if you keep your muscle — at ${start.target}% you'd weigh about ${fmtInt(proj.central.w[proj.central.reachedAt ?? proj.days - 1])} lb. Body fat is the better target for the physique you want.</p>` : ""}
  </section>`;
}

/* ── projection chart and what-if ──────────────────────────────────────── */

export function projectionCard(ctx) {
  const fc = forecastOf(ctx);
  if (!fc) return "";
  const { start, floor } = fc;
  const s = { ...(ctx.ui.fc || {}) };
  const v = {
    kcal: s.kcal ?? start.intakeNow, sessions: s.sessions ?? Math.round(start.sessions), steps: s.steps ?? (start.steps != null ? Math.round(start.steps / 500) * 500 : null),
    protein: s.protein ?? (start.proteinG != null ? Math.round(start.proteinG / 5) * 5 : null), maintainAtGoal: s.maintainAtGoal !== false, breakEvery: s.breakEvery || 0,
  };
  const slider = (name, label, val, min, max, step, fmt, note = "") => `<label class="fcsl"><span>${label}</span><b data-fc-v="${name}">${fmt(val)}</b>
      <input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${val}" data-fc>${note ? `<em>${note}</em>` : ""}</label>`;
  const span = ctx.ui.fcSpan || 365;
  const view = ctx.ui.fcView || "weight";
  return `<section class="card fcproj" id="projection">
    <div class="cardhead"><h2>Projection <span class="sub">your logged weight, and where the model says it's heading</span></h2>
      <div class="tabs">${[["weight", "Weight"], ["bf", "Body fat"], ["lean", "Lean mass"]].map(([k, l]) => `<button type="button" class="tab${k === view ? " on" : ""}" data-act="fc-view" data-v="${k}">${l}</button>`).join("")}</div></div>
    <div class="tabs fcspan">${[[91, "3 months"], [182, "6 months"], [365, "1 year"], [730, "2 years"]].map(([d, l]) => `<button type="button" class="tab${d === span ? " on" : ""}" data-act="fc-span" data-v="${d}">${l}</button>`).join("")}</div>
    <div data-fc-out>${projectionOut(ctx)}</div>
    <form class="fcwhatif" data-form="fc" onsubmit="return false">
      <div class="sec-l">What if… <span class="sub">drag to see how a change would play out — nothing here changes your targets</span></div>
      <div class="fcsls">
        ${slider("kcal", "Calories a day", v.kcal, Math.max(1000, Math.floor(floor / 25) * 25), 4000, 25, (x) => `${fmtInt(x)} kcal`, `now ~${fmtInt(start.intakeNow)} · floor ${fmtInt(floor)}`)}
        ${slider("sessions", "Lifting sessions a week", v.sessions, 0, 7, 1, (x) => `${x}`, `now ~${start.sessions.toFixed(1)}`)}
        ${v.steps != null ? slider("steps", "Steps a day", v.steps, 0, 25000, 500, (x) => fmtInt(x), `now ~${fmtInt(start.steps)}`) : `<div class="fcsl off"><span>Steps a day</span><em>Needs a couple of weeks of step counts from Apple Health.</em></div>`}
        ${v.protein != null ? slider("protein", "Protein a day", v.protein, 40, 320, 5, (x) => `${x} g · ${(x / (start.weight * KG)).toFixed(1)} g/kg`, `now ~${fmtInt(start.proteinG)} g`) : `<div class="fcsl off"><span>Protein a day</span><em>Needs complete food days.</em></div>`}
      </div>
      <div class="fcopts">
        <label class="chk"><input type="checkbox" name="maintainAtGoal" data-fc${v.maintainAtGoal ? " checked" : ""}><i style="--c:#56C990"></i>Switch to maintenance at ${start.target}% body fat</label>
        <label class="field"><span>Diet breaks</span><span class="inp"><select name="breakEvery" data-fc>${[[0, "None"], [6, "1 week every 6"], [8, "1 week every 8"], [12, "1 week every 12"]].map(([n, l]) => `<option value="${n}"${v.breakEvery === n ? " selected" : ""}>${l}</option>`).join("")}</select></span></label>
        <button type="button" class="btn" data-act="fc-reset" data-fc-reset${ctx.ui.fc && Object.keys(ctx.ui.fc).length ? "" : " hidden"}>Back to what you're doing now</button>
      </div>
      <p class="hint small">Extra steps and sessions are counted modestly (about ${Math.round(0.0005 * start.weight * KG * 1000)} kcal per 1,000 steps, ~150 kcal net per session) — never what a watch says. A diet break is a week at maintenance; it adds time but can make a long cut easier to stick to (Byrne 2018).</p>
    </form>
    ${howHtml()}
  </section>`;
}

/** A slider's value as shown beside it. */
export function fcValueText(ctx, name, v) {
  const start = forecastOf(ctx)?.start;
  if (name === "kcal") return `${fmtInt(v)} kcal`;
  if (name === "steps") return fmtInt(v);
  if (name === "protein") return `${v} g · ${start ? (v / (start.weight * KG)).toFixed(1) : "—"} g/kg`;
  return String(v);
}

/** The part that redraws as you drag: the chart and what the scenario changes. */
export function projectionOut(ctx) {
  const fc = forecastOf(ctx);
  if (!fc) return "";
  const { start, proj, scProj, scIn, milestones } = fc;
  let summary = "";
  if (scProj) {
    const t = start.target;
    const m1 = scProj.milestones.find((m) => m.bf === t);
    const sooner = pairedSooner(fc.base40, scProj, t);
    const diffWeeks = sooner == null || m1?.median == null ? null : Math.round(sooner / 7);
    const r0 = retention(proj.central, start), r1 = retention(scProj.central, start);
    const firstRate = ((scProj.central.w[0] - scProj.central.w[28]) / 4 / start.weight) * 100;
    const warn = [];
    if (firstRate > 1) warn.push(`That's about ${firstRate.toFixed(1)}% of body weight a week at first — faster than ~1% raises muscle loss.`);
    if (scIn.factor > 0.75 && start.phase === "cut") warn.push("With little lifting or low protein, more of the loss comes from muscle.");
    const lean6 = (p) => p.lean.p50[182] - p.lean.p50[0];
    summary = `<div class="fcsum">
      <div><span>${t}% body fat</span><b>${(() => { const m0 = proj.milestones.find((m) => m.bf === t); if (m1?.median == null) return "not reached"; return when(ctx.today, m0?.median != null && sooner != null ? Math.max(0, Math.round(m0.median - sooner)) : m1.median); })()}</b><em>${diffWeeks == null ? "" : diffWeeks === 0 ? "about the same as now" : `${Math.abs(diffWeeks)} week${Math.abs(diffWeeks) === 1 ? "" : "s"} ${diffWeeks > 0 ? "sooner" : "later"} than now`}</em></div>
      <div><span>In 6 months</span><b>${scProj.w.p50[182].toFixed(1)} lb</b><em>vs ${proj.w.p50[182].toFixed(1)} lb on your current path</em></div>
      <div><span>Lean mass, 6 months</span><b>${lean6(scProj) >= 0 ? "+" : "−"}${Math.abs(lean6(scProj)).toFixed(1)} lb</b><em>${(() => { const d = pairedLean(fc.base40, scProj); return Math.abs(d) < 0.1 ? "about the same as now" : `${Math.abs(d).toFixed(1)} lb ${d > 0 ? "more kept" : "more lost"} than now`; })()} · outlook ${r1.word.toLowerCase()}</em></div>
      <div><span>Starting pace</span><b>${firstRate >= 0 ? "−" : "+"}${Math.abs(firstRate).toFixed(2)}%<small>/wk</small></b><em>first four weeks</em></div>
    </div>${warn.length ? `<ul class="ea-warn">${warn.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}`;
  }
  return `<div class="chartbox" data-chart="forecast"></div>
    <div class="legend small"><span><i class="lg-dot fc-act"></i>Your weigh-ins (7-day average line)</span><span><i class="lg-band fc-band"></i>Current path, likely range</span>${scProj ? `<span><i class="lg-line fc-sc"></i>Your what-if</span>` : ""}${fc.bt ? `<span><i class="lg-dash fc-bt"></i>What the model expected 6 weeks ago</span>` : ""}</div>
    ${fc.bt ? backtestNote(ctx, fc) : ""}
    ${summary}`;
}

function backtestNote(ctx, fc) {
  const bt = fc.bt;
  const actual = weightAt(ctx.days, ctx.today);
  const expected = bt.w.at(-1);
  if (actual == null) return "";
  const diff = actual - expected;
  return `<p class="hint small">Six weeks ago, from maintenance then estimated at ${fmtInt(bt.tdee)} kcal and the ${fmtInt(bt.intake)} kcal you averaged since, the model expected about <b>${expected.toFixed(1)} lb</b> today; your 7-day average is <b>${actual.toFixed(1)} lb</b> (${Math.abs(diff) < 1 ? "within a pound — a good sign the inputs are right" : `${diff > 0 ? "heavier" : "lighter"} by ${Math.abs(diff).toFixed(1)} lb${Math.abs(diff) > 2 ? " — part of that is usually water; the estimate recalibrates each week" : ""}`}).</p>`;
}

/** The chart's data for the CHARTS registry. */
export function forecastChartData(ctx) {
  const fc = forecastOf(ctx);
  const span = ctx.ui.fcSpan || 365;
  const view = ctx.ui.fcView || "weight";
  const key = view === "bf" ? "bf" : view === "lean" ? "lean" : "w";
  const back = 84;
  const hist = [];
  for (let i = back; i >= 0; i--) {
    const k = addDays(ctx.today, -i);
    const d = ctx.days[k];
    if (view === "weight" && d?.weight != null) hist.push({ x: -i, v: d.weight, avg: weightAt(ctx.days, k) });
    if (view === "bf" && d?.bodyFat != null) hist.push({ x: -i, v: d.bodyFat });
  }
  const n = Math.min(span, fc.proj.days - 1);
  const band = Array.from({ length: n + 1 }, (_, t) => ({ x: t, lo: fc.proj[key].p10[t], mid: fc.proj[key].p50[t], hi: fc.proj[key].p90[t] }));
  const sc = fc.scProj ? Array.from({ length: n + 1 }, (_, t) => ({ x: t, v: fc.scProj[key].p50[t] })) : null;
  const bt = view === "weight" && fc.bt ? fc.bt.w.map((v, i) => ({ x: i - (fc.bt.w.length - 1), v })) : null;
  const marks = view === "lean" ? [] : fc.proj.milestones.filter((m) => m.median != null && m.median > 0 && m.median <= n).map((m) => ({ x: m.median, label: `${m.bf}%` }));
  const goal = view === "weight" && fc.goalWeight ? fc.goalWeight : view === "bf" ? fc.start.target : null;
  return { hist, band, sc, bt, marks, goal, back, n, unit: view === "bf" ? "%" : "lb", today: ctx.today };
}

/* ── what would help ───────────────────────────────────────────────────── */

function recommendations(fc) {
  const { start, baseIn, proj, floor } = fc;
  const out = [];
  const t = start.target;
  // compared exactly as the what-if panel does: run-by-run against the same 40-run baseline
  const base = fc.base40;
  const try1 = (change) => project({ ...baseIn, ...change }, { ...fc.opts, runs: 40 });
  const soonerW = (p) => { const d = pairedSooner(base, p, t); return d == null ? null : Math.round(d / 7); };
  const keptLb = (p) => Math.max(0, pairedLean(base, p));
  if (start.phase === "cut" && fc.status.id === "fast") {
    const kcal = start.intakeNow + 200;
    const s = try1({ intake: kcal });
    const w = soonerW(s), later = w == null ? null : -w;
    out.push({ kind: "watch", title: `Ease off: about ${fmtInt(kcal)} kcal a day`, text: `Slows the loss toward ~1% a week. Projected to keep ~${keptLb(s).toFixed(1)} lb more lean mass over six months${later != null && later > 0 ? `, for about ${later} week${later === 1 ? "" : "s"} longer to ${t}%` : ""}.` });
  }
  if (start.protein != null && start.protein < 1.6) {
    const g = Math.round(1.8 * start.weight * KG / 5) * 5;
    const s = try1({ factor: leanFactor(start.sessions, 1.8) });
    out.push({ kind: "watch", title: `Protein to ~${g} g a day`, text: `You're averaging ${start.protein.toFixed(1)} g/kg; 1.6–2.4 g/kg best protects muscle in a deficit (Morton 2018; Helms 2014). Projected ~${keptLb(s).toFixed(1)} lb more lean mass kept over six months.` });
  }
  if (start.sessions < 2.5 && start.phase !== "maintain") {
    const s = try1({ factor: leanFactor(3, start.protein), activity: ((3 - start.sessions) * 150) / 7 });
    out.push({ kind: "watch", title: "Lift at least 3 times a week", text: `You've averaged ${start.sessions.toFixed(1)} sessions a week lately. Hard resistance training is the strongest signal to keep muscle while cutting — projected ~${keptLb(s).toFixed(1)} lb more lean mass over six months.` });
  }
  if (start.phase === "cut" && fc.status.id === "slow") {
    const kcal = Math.max(floor, start.intakeNow - 150);
    if (kcal < start.intakeNow) {
      const s = try1({ intake: kcal });
      const sooner = soonerW(s);
      out.push({ kind: "info", title: `Trim ~${fmtInt(start.intakeNow - kcal)} kcal (to ${fmtInt(kcal)})`, text: `${sooner != null && sooner > 0 ? `Reaches ${t}% about ${sooner} weeks sooner. ` : ""}Check first that every day's food is logged in full — gaps make maintenance look lower than it is.` });
    }
    if (start.steps != null) {
      const s = try1({ activity: 2000 * 0.0005 * start.weight * KG });
      const sooner = soonerW(s);
      out.push({ kind: "info", title: `+2,000 steps a day (to ~${fmtInt(start.steps + 2000)})`, text: `${sooner != null && sooner > 0 ? `About ${sooner} weeks sooner to ${t}%` : "A little faster"} without eating less, and it's gentler on recovery than more hard training.` });
    }
  }
  if (start.intakeDays > 0 && start.intakeDays < 8) out.push({ kind: "info", title: "Log more complete food days", text: `The forecast leans on ${start.intakeDays} complete days from the last two weeks; 10+ make maintenance — and every date here — much sharper.` });
  if (start.sleep != null && start.sleep < 420) out.push({ kind: "info", title: "Protect sleep (7+ hours)", text: "In a controlled study, short sleep during a diet shifted weight loss from fat toward lean tissue (Nedeltcheva 2010)." });
  const weeks = base.milestones.find((m) => m.bf === t)?.median ?? null;
  if (out.length < 4 && weeks != null && weeks > 26 * 7 && !fc.baseIn.breakEvery) {
    const s = try1({ breakEvery: 8 });
    const w = soonerW(s), later = w == null ? null : -w;
    out.push({ kind: "info", title: "Plan diet breaks for a long cut", text: `${t}% is over six months away. A week at maintenance every 8 weeks adds ${later != null ? `about ${later} weeks` : "some time"}, and can make the whole cut easier to sustain.` });
  }
  if (!out.length && start.ratePct != null) out.push({ kind: "good", title: "Keep doing what you're doing", text: "Pace, protein and training are all in good ranges. Keep logging; the forecast sharpens every week." });
  return out.slice(0, 4);
}

export function helpCard(ctx) {
  const fc = forecastOf(ctx);
  if (!fc) return "";
  const cls = { watch: "mid", info: "none", good: "ok" };
  return `<section class="card fchelp">
    <div class="cardhead"><h2>What would help <span class="sub">ranked; nothing changes unless you change it</span></h2></div>
    <div class="fcrecs">${fc.recs.map((r) => `<div class="fcrec"><span class="epill sm ${cls[r.kind]}">${r.kind === "watch" ? "Priority" : r.kind === "good" ? "Good" : "Option"}</span><div><b>${esc(r.title)}</b><p>${esc(r.text)}</p></div></div>`).join("")}</div>
    <p class="hint small">To change your actual calorie target, use the suggestion on the Weight page (Metabolism &amp; energy balance) or Settings → Goals.</p>
  </section>`;
}

function howHtml() {
  return `<details class="howto"><summary>How the forecast works</summary>
    <ol>
      <li><b>A dynamic model, not 3,500 kcal a pound.</b> Your body is split into fat and lean mass (Hall 2008; Hall et al. 2011). Each day the energy gap is drawn from fat (9,440 kcal/kg) and lean tissue (1,816 kcal/kg) by Forbes' rule, and what you burn falls as you get lighter — resting cost of the tissue lost, moving a lighter body, digestion, and adaptive thermogenesis when you eat less. So the same calories give a slowing loss.</li>
      <li><b>Started from your data.</b> Maintenance is the adaptive estimate from your logged intake and weigh-ins (Weight page), so it already reflects your real burn — and any under-logging. Watch calories never enter.</li>
      <li><b>Muscle.</b> Forbes' split is for people who don't lift. Regular lifting and higher protein reduce the lean share of losses substantially (Weinheimer 2010; Sardeli 2018; Longland 2016), losing faster than ~1% a week raises it (Helms 2014). The effect sizes are approximate, so they're varied in the ranges.</li>
      <li><b>Ranges.</b> The model runs 80 times with maintenance, starting body fat, day-to-day adherence and the muscle effect varied within their uncertainty; the band is the middle 80% of outcomes. Water and glycogen shift a pound or so when intake changes — that's modelled too, and it's why the line can jump when you move to maintenance.</li>
      <li><b>Not forever.</b> By default the forecast switches to maintenance at your target body fat rather than assuming you diet indefinitely. Long-range numbers are the least certain: bodies, habits and goals change.</li>
      <li><b>Checked against you.</b> The dashed line is what the model would have predicted six weeks ago; how close it lands is a fair test of the inputs.</li>
    </ol>
  </details>`;
}
