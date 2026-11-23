/* ──────────────────────────────────────────────────────────────────────────
   Recovery & readiness on the page: a compact card on Today with the
   daily check-in, and the detailed section on Fitness. The judgement is
   js/readiness.js; this lays it out.
   ────────────────────────────────────────────────────────────────────────── */
import { energyOf } from "./energyview.js";
import { readiness, readinessAdvice, readinessHistory, STATUS, dayLoad, sleepVsPerformance } from "./readiness.js";
import { esc, tip } from "./charts.js";
import { addDays, range, sleepMinutes } from "./metrics.js";

const CHECK = [
  ["soreness", "Soreness", ["None", "", "Some", "", "Very sore"], true],
  ["fatigue", "Fatigue", ["Fresh", "", "Some", "", "Exhausted"], true],
  ["motivation", "Motivation", ["None", "", "OK", "", "High"], false],
  ["energy", "Energy", ["Low", "", "OK", "", "High"], false],
];
const LEVEL = { strong: ["bad", "Strong signal"], mild: ["mid", "Mild"], good: ["ok", "Fine"] };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayShort = (k) => { const [, m, d] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };

/** Today's readiness, worked out once per draw. */
export function readinessOf(ctx) {
  if (ctx._ready) return ctx._ready;
  const e = energyOf(ctx);
  const deficitPct = e.intake?.kcal != null ? ((e.energy.estimate - e.intake.kcal) / e.energy.estimate) * 100 : null;
  const opts = { days: ctx.days, g: ctx.g, strengthStatus: e.strength?.status, deficitPct, proteinGkg: e.strength?.preservation?.protein ?? null, lossPct: e.trend?.enough ? -e.trend.pctPerWeek : null };
  const r = readiness({ ...opts, today: ctx.today });
  ctx._ready = { r, opts, advice: readinessAdvice(r, opts) };
  return ctx._ready;
}

function checkinHtml(ctx) {
  const ci = ctx.days[ctx.today]?.checkin || {};
  return `<div class="cin">${CHECK.map(([f, label, words, worseHigh]) => `<div class="cin-row"><span class="cin-l">${label}</span>
      <div class="cin-b" role="group" aria-label="${label}">${[1, 2, 3, 4, 5].map((v) => `<button type="button" class="cin-v${ci[f] === v ? " on" : ""} ${worseHigh ? (v >= 4 ? "hi-bad" : "") : (v <= 2 ? "lo-bad" : "")}" data-act="ci-set" data-f="${f}" data-v="${v}" ${tip(`${label}: ${v}`, words[v - 1] || "")} aria-pressed="${ci[f] === v}">${v}</button>`).join("")}</div>
      <span class="cin-w">${ci[f] ? esc(words[ci[f] - 1] || "") : ""}</span></div>`).join("")}</div>`;
}

/** The compact card on Today. */
export function recoveryToday(ctx) {
  if (ctx.state.demo) return "";
  const { r, advice } = readinessOf(ctx);
  const st = STATUS[r.status];
  const top = r.signals.filter((s) => s.level === "strong")[0] || r.signals.filter((s) => s.level === "mild")[0] || r.signals.find((s) => s.level === "good");
  const done = !!ctx.days[ctx.today]?.checkin;
  return `<section class="card recov-today" id="recovery-today">
    <div class="cardhead"><h2>Recovery <span class="sub">how today looks</span></h2><span class="epill ${st.cls}">${st.word}</span></div>
    ${top ? `<p class="rt-why">${esc(top.text)}</p>` : ""}
    ${advice[0] ? `<p class="rt-do"><b>Today:</b> ${esc(advice[0].text)}</p>` : ""}
    <details class="howto rt-ci"${done ? "" : " open"}><summary>${done ? "Today's check-in ✓" : "How do you feel? (10-second check-in)"}</summary>${checkinHtml(ctx)}</details>
    <a class="linkbtn quiet" href="#/fitness" data-jump="recovery">Recovery details →</a>
  </section>`;
}

/** The detailed section on Fitness. */
export function recoveryCard(ctx) {
  const { r, advice } = readinessOf(ctx);
  const st = STATUS[r.status];
  const hist = readinessHistory({ ...readinessOf(ctx).opts, today: ctx.today }, 28);
  const strip = hist.map((h) => `<span class="rs ${STATUS[h.status].cls}${h.key === ctx.today ? " today" : ""}" ${tip(dayShort(h.key), STATUS[h.status].word, h.signals.filter((s) => s.level === "strong").map((s) => s.text.split(" — ")[0]).join(" · ") || "")}></span>`).join("");
  const group = (kind, title) => {
    const list = r.signals.filter((s) => s.kind === kind);
    return list.length ? `<div class="rsig-g"><span class="ea-l">${title}</span><ul class="snotes">${list.map((s) => `<li><span class="epill sm ${LEVEL[s.level][0]}">${LEVEL[s.level][1]}</span><span>${esc(s.text)}</span></li>`).join("")}</ul></div>` : "";
  };
  const missing = [
    r.sleep == null && "last night's sleep (Log today)",
    !r.rhr.enough && "resting heart rate (Apple Health, a few weeks)",
    !r.hrv.enough && "HRV (Apple Health, a few weeks)",
    !ctx.days[ctx.today]?.checkin && "today's check-in",
  ].filter(Boolean);
  return `<section class="card energycard recovcard" id="recovery">
    <div class="cardhead"><h2>Recovery &amp; readiness <span class="sub">sleep, heart, training load, performance and how you feel</span></h2>
      <span class="epill ${st.cls}" ${tip(st.word, `${r.inputs} kind${r.inputs === 1 ? "" : "s"} of data today · ${r.confidence} confidence`)}>${st.word}</span></div>
    <div class="radvice">${advice.map((a) => `<p class="${a.kind}">${esc(a.text)}</p>`).join("")}</div>
    <div class="rsigs">${group("objective", "Measured")}${group("subjective", "How you feel")}${group("context", "Context")}</div>
    ${missing.length ? `<p class="hint small">Sharper with: ${esc(missing.join(", "))}.</p>` : ""}
    <div class="sec-l">Last 4 weeks <span class="sub">each day judged on what was known by then</span></div>
    <div class="rstrip">${strip}</div>
    <div class="legend small">${Object.values(STATUS).map((s) => `<span><i class="lg-sq rs ${s.cls}"></i>${s.word}</span>`).join("")}</div>
    <div class="rcharts">
      <div><div class="sec-l">Resting heart rate &amp; HRV <span class="sub">daily, with your 7-day average</span></div><div class="chartbox" data-chart="heart"></div></div>
      <div><div class="sec-l">Training load vs sleep <span class="sub">by week</span></div><div class="chartbox" data-chart="loadsleep"></div></div>
    </div>
    <div class="sec-l">Sleep vs lifting performance <span class="sub">each session: the night before, and how it went against that lift's recent level</span></div>
    <div class="chartbox" data-chart="sleepperf"></div>
    <div class="rci-full"><div class="sec-l">Today's check-in</div>${checkinHtml(ctx)}</div>
    <details class="howto"><summary>How readiness is judged</summary>
      <ol>
        <li><b>Against your own normal.</b> Resting heart rate (last 3 days) and HRV (last 7 days) are compared with your previous four weeks; only changes bigger than your usual day-to-day variation, on most of those days, count (Plews 2013; Buchheit 2014). Apple Health's HRV is SDNN — useful for trends, noisier than lab measures.</li>
        <li><b>Training load</b> is working sets plus other workout minutes, this week against the three before; a jump of 1.5× or more is a spike. Load ratios are imperfect predictors (Impellizzeri 2020), so it's only one signal.</li>
        <li><b>No single reading decides.</b> One strong signal (or two mild) = moderate fatigue; two sustained strong signals = recovery recommended. A rest day is never suggested from one unusual morning.</li>
        <li><b>Context</b> — a big deficit, fast loss or low protein — doesn't mean you're fatigued, but makes it likelier and slower to clear.</li>
        <li>This is a guide to help you decide, not a measure of your physiology or a medical judgement. If you feel unwell, rest regardless.</li>
      </ol>
    </details>
  </section>`;
}

/* ── chart data ────────────────────────────────────────────────────────── */

export function heartRows(ctx, n = 60) {
  return range(addDays(ctx.today, -(n - 1)), ctx.today).map((k) => ({ key: k, rhr: ctx.days[k]?.restingHR ?? null, hrv: ctx.days[k]?.hrv ?? null }));
}

export function loadSleepRows(ctx, weeks = 10) {
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = addDays(ctx.today, -7 * i), start = addDays(end, -6);
    const ks = range(start, end);
    const load = ks.reduce((s, k) => s + dayLoad(ctx.days[k]).load, 0);
    const sl = ks.map((k) => sleepMinutes(ctx.days[k])).filter((v) => v != null);
    out.push({ key: end, load, sleep: sl.length >= 3 ? sl.reduce((a, b) => a + b, 0) / sl.length / 60 : null });
  }
  return out;
}

export function sleepPerfPoints(ctx) {
  const s = energyOf(ctx).strength;
  return s ? sleepVsPerformance(ctx.days, ctx.today, s.exercises) : [];
}
