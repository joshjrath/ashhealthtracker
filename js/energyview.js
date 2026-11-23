/* ──────────────────────────────────────────────────────────────────────────
   The Weight page's "Metabolism & energy balance" card: the adaptive TDEE
   estimate (js/energy.js) with its range and confidence, what you've eaten
   on complete days, the measured weight trend, a suggested calorie target
   you can accept or not, and whether progress has really stalled.

   Estimates, logged values and measured trends are labelled as such.
   ────────────────────────────────────────────────────────────────────────── */
import { adaptiveTdee, plateau, weightTrend, intakeSummary, calorieAdvice, pastPlateaus, PHASES } from "./energy.js";
import { esc, tip } from "./charts.js";
import { fmtInt } from "./metrics.js";

const CONF = {
  preliminary: { word: "Preliminary", why: "Mostly your maintenance setting so far — it calibrates once there are 2+ weeks of complete food days and weigh-ins." },
  developing: { word: "Developing", why: "Calibrating from your logs; the range narrows as weeks add up." },
  established: { word: "Established", why: "Six or more weeks of consistent logs back this estimate." },
};
const STATUS = {
  progressing: { word: "Progressing", cls: "ok" },
  slowing: { word: "Slowing", cls: "mid" },
  possible: { word: "Possible plateau", cls: "mid" },
  confirmed: { word: "Confirmed trend plateau", cls: "bad" },
  insufficient: { word: "Not enough data", cls: "none" },
  steady: { word: "Steady", cls: "ok" },
  "drifting down": { word: "Drifting down", cls: "mid" },
  "drifting up": { word: "Drifting up", cls: "mid" },
  gaining: { word: "Gaining", cls: "ok" },
  "not gaining": { word: "Not gaining", cls: "mid" },
};
const KIND = { plausible: "Possible factor", data: "Data quality", expected: "Expected", water: "Likely water" };
const tag = (t) => `<span class="etag ${t}">${{ est: "Estimated", logged: "Logged", measured: "Measured trend" }[t]}</span>`;

/** Everything this card needs, worked out once per draw. */
export function energyOf(ctx) {
  if (ctx._energy) return ctx._energy;
  const { days, g, today } = ctx;
  const phase = g.phase || "cut";
  const energy = adaptiveTdee(days, g, today);
  const plat = plateau(days, g, today, energy, phase);
  const trend = weightTrend(days, today, 28);
  const intake = intakeSummary(days, today);
  const weight = trend.enough ? trend.now : plat.nowAvg;
  const advice = weight ? calorieAdvice({ days, g, today, energy, plat, phase, strength: ctx.strength, weight }) : null;
  ctx._energy = { energy, plat, trend, intake, advice, phase, weight };
  return ctx._energy;
}

export function metabolismCard(ctx) {
  const { energy, plat, trend, intake, advice, phase } = energyOf(ctx);
  const c = CONF[energy.confidence];
  const cell = (label, value, note, t) => `<div><span>${label} ${tag(t)}</span><b>${value}</b><em>${note}</em></div>`;
  const deficit = intake?.kcal != null ? energy.estimate - intake.kcal : null;
  const dRange = intake?.kcal != null ? [energy.low - intake.kcal, energy.high - intake.kcal] : null;
  const kpis = `<div class="fgrid four ekpis">
    ${cell("Estimated maintenance", `${fmtInt(energy.estimate)}<small>kcal</small>`, `likely ${fmtInt(energy.low)}–${fmtInt(energy.high)} · started from ${fmtInt(energy.baseline)}`, "est")}
    ${cell("Average intake", intake ? `${fmtInt(intake.kcal)}<small>kcal</small>` : "—", intake ? `${intake.days} complete day${intake.days === 1 ? "" : "s"} of the last ${intake.n}${intake.partial ? ` · ${intake.partial} partial left out` : ""}` : "Needs 5+ complete food days in two weeks", "logged")}
    ${cell(deficit == null ? "Deficit / surplus" : deficit >= 0 ? "Daily deficit" : "Daily surplus", deficit == null ? "—" : `${deficit >= 0 ? "≈" : "+"}${fmtInt(Math.abs(deficit))}<small>kcal</small>`, dRange ? `range ${fmtInt(dRange[0])} to ${fmtInt(dRange[1])}` : "maintenance minus intake", "est")}
    ${cell("Weight trend", trend.enough ? `${trend.lbPerWeek <= 0 ? "−" : "+"}${Math.abs(trend.lbPerWeek).toFixed(1)}<small>lb/wk</small>` : "—", trend.enough ? `${trend.pctPerWeek <= 0 ? "−" : "+"}${Math.abs(trend.pctPerWeek).toFixed(2)}% of body weight a week · ${trend.n} weigh-ins, 28 days` : "Needs ~8 weigh-ins across 14+ days", "measured")}
  </div>`;

  let adviceHtml = "";
  if (advice && energy.confidence === "preliminary") {
    adviceHtml = `<div class="eadvice muted"><p><b>No calorie suggestion yet.</b> ${esc(c.why)}</p></div>`;
  } else if (advice) {
    const dismissed = Number(ctx.ui.adviceDismissed);
    const show = advice.suggest && !(Number.isFinite(dismissed) && Math.abs(dismissed - advice.target) < 100);
    adviceHtml = `<div class="eadvice${show ? " suggest" : ""}">
      <div class="ea-head">
        <div><span class="ea-l">${esc(PHASES[phase]?.label || "Fat loss")} · suggested target</span>
          <b>${fmtInt(advice.target)} kcal</b><em>${fmtInt(advice.low)}–${fmtInt(advice.high)} · yours is ${fmtInt(advice.current)}${advice.suggest ? ` (${advice.diff > 0 ? "+" : "−"}${fmtInt(Math.abs(advice.diff))})` : " — close enough, no change needed"}</em></div>
        ${show ? `<div class="actions"><button type="button" class="btn primary" data-act="advice-accept" data-v="${advice.target}">Use ${fmtInt(advice.target)}</button><button type="button" class="btn" data-act="advice-dismiss" data-v="${advice.target}">Not now</button></div>` : ""}
      </div>
      <ul class="ea-why">${advice.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}
        ${advice.proteinTarget ? `<li>Protein for this phase: about ${advice.proteinTarget[0]}–${advice.proteinTarget[1]} g a day${advice.proteinGkg != null ? ` (you're averaging ${advice.proteinGkg.toFixed(1)} g/kg)` : ""}.</li>` : ""}</ul>
      ${advice.cautions.length ? `<ul class="ea-warn">${advice.cautions.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      <p class="hint small">Nothing changes unless you press Use. It never goes below ${fmtInt(advice.floor)} kcal, and it won't cut further just because the scale stalls for a week or two.</p>
    </div>`;
  }

  const st = STATUS[plat.status] || STATUS.insufficient;
  const past = pastPlateaus(ctx.days, ctx.today);
  const plateauHtml = `<div class="eplat">
    <div class="ep-head"><span class="epill ${st.cls}">${st.word}</span>
      <span>${plat.duration >= 7 ? `7-day average within ±0.6 lb for ${plat.duration} days` : ""}${plat.expected != null && plat.t28?.enough ? `${plat.duration >= 7 ? " · " : ""}expected ${plat.expected <= 0 ? "−" : "+"}${Math.abs(plat.expected).toFixed(1)} lb/wk from the estimated deficit, measured ${plat.t28.lbPerWeek <= 0 ? "−" : "+"}${Math.abs(plat.t28.lbPerWeek).toFixed(1)}` : ""}</span></div>
    <p class="ep-next">${esc(plat.next)}</p>
    ${plat.factors.length ? `<ul class="ep-factors">${plat.factors.map((f) => `<li><span class="etag ${f.kind}">${KIND[f.kind]}</span>${esc(f.text)}</li>`).join("")}</ul>` : ""}
    ${plat.factors.length ? `<p class="hint small">These are possibilities that fit the data, not confirmed causes. Weight swings 1–3 lb with water, salt, carbs and training, so a flat scale for a week or two doesn't mean fat loss stopped.</p>` : ""}
    ${past.length ? `<details class="howto"><summary>Earlier plateaus (${past.length})</summary><ul class="ep-past">${past.map((p) => `<li><b>${esc(p.start)} → ${esc(p.end)}</b> (${p.weeks} weeks flat). After it: intake ${p.intake[0] != null && p.intake[1] != null ? `${fmtInt(p.intake[0])} → ${fmtInt(p.intake[1])} kcal` : "not enough logs"}, steps ${p.steps[0] != null && p.steps[1] != null ? `${fmtInt(p.steps[0])} → ${fmtInt(p.steps[1])}` : "—"}. Associated with the trend resuming — not proof of what caused it.</li>`).join("")}</ul></details>` : ""}
  </div>`;

  return `<section class="card energycard" id="energy">
    <div class="cardhead"><h2>Metabolism &amp; energy balance <span class="sub">how much you burn, from what you eat and how your weight moves</span></h2>
      <span class="conf ${energy.confidence}" ${tip(`${c.word} estimate`, c.why, `${energy.obsWeeks} week${energy.obsWeeks === 1 ? "" : "s"} of usable data`)}>${c.word}</span></div>
    ${kpis}
    ${adviceHtml}
    <div class="sec-l">Estimated maintenance vs intake, by week</div>
    <div class="chartbox" data-chart="energy"></div>
    <div class="legend small"><span><i class="lg-band"></i>Estimated maintenance (likely range)</span><span><i class="lg-dot"></i>Average intake, complete days</span><span><i class="lg-dash"></i>Weight trend (right axis)</span></div>
    <div class="sec-l">Is progress stalling?</div>
    ${plateauHtml}
    <details class="howto"><summary>How this is worked out</summary>
      <ol>
        <li><b>Burn ≈ eaten − energy in the weight change.</b> Each week looks back 21 days: the average of your <i>complete</i> food days (missing or partial days are left out, never counted as zero) and a robust (Theil–Sen) line through your weigh-ins, so a single odd morning can't swing it.</li>
        <li><b>Not 3,500 kcal per pound.</b> Following the NIH body-weight model (Hall 2008; Hall et al., Lancet 2011), a change splits between fat (9,440 kcal/kg) and lean tissue (1,816 kcal/kg) by Forbes' rule — about ${fmtInt(energy.perLb)} kcal per lb for you${energy.bodyFat ? ` at ~${energy.bodyFat.pct}% body fat (${energy.bodyFat.kind === "logged" ? "logged" : energy.bodyFat.kind === "settings" ? "your estimate" : "rough BMI estimate"})` : " (assuming ~20% body fat until you log one)"}.</li>
        <li><b>Calibrated gradually.</b> It starts from your maintenance setting and each week's reading moves it in proportion to how trustworthy that reading is (a Kalman filter): fewer complete days and noisier weigh-ins move it less. Water and glycogen get a noise floor, so short swings don't read as metabolism.</li>
        <li><b>Activity as a hint, not a measurement.</b> Apple Watch calories are never added on top — that would count exercise twice. If your activity changes, the estimate is nudged by half of a 25%-discounted change (wrist devices tend to overstate burn), and your weigh-ins confirm or undo it.</li>
        <li><b>Lighter bodies burn less.</b> As your trend weight falls the estimate drops about 8 kcal a day per pound — normal, and not the same as "metabolic adaptation", which this never assumes from a plateau.</li>
      </ol>
      <p class="hint small">An estimate with a range, not a clinical measurement. Under-logging lowers it too — it's "what you burn, as you log it", which is what targets need.</p>
    </details>
  </section>`;
}
