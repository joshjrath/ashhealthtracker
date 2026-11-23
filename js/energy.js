/* ──────────────────────────────────────────────────────────────────────────
   How much you really burn — an adaptive estimate of your TDEE.

   It starts from the maintenance you set (2,500 kcal by default) and, week
   by week, checks it against what actually happened: what you ate on days
   you logged completely, and how your weight trend moved.

     burned ≈ eaten − (energy in the weight you lost or gained)

   The energy in a pound of weight change isn't 3,500 kcal. Following the
   NIH body-weight model (Hall 2008; Hall et al., Lancet 2011), a change is
   split between fat (9,440 kcal/kg) and lean tissue (1,816 kcal/kg, mostly
   water) by Forbes' rule, so the leaner you are the fewer calories a pound
   holds — about 2,600–3,000 kcal/lb at 12–25% body fat.

   Guarding against noise:
     · only complete food days count; a missing or half-logged day is never
       read as zero calories
     · the weight trend is a robust (Theil–Sen) line through three weeks of
       weigh-ins, so one odd morning barely moves it
     · each week's reading is weighed by how certain it is (a Kalman filter):
       water, glycogen and sodium swings get a noise floor, gaps in the food
       log widen it, and the estimate only drifts slowly
     · Apple Watch calories are never added on top (that would count your
       exercise twice); a change in your activity nudges the estimate by half
       of a discounted amount, as a hint the next weigh-ins confirm or undo

   The result is an estimate with a range and a confidence level, never a
   clinical measurement.
   ────────────────────────────────────────────────────────────────────────── */
import { addDays, range, daysBetween, foodStatus, sleepMinutes, MIN } from "./metrics.js";
import { restingEnergy, intakeFloor, bodyFatFromBmi } from "./profile.js";

export const RHO_F = 9440; // kcal per kg of fat tissue
export const RHO_L = 1816; // kcal per kg of lean tissue
const FORBES = 10.4; // kg — Forbes: dL/dF = 10.4 / F
export const KG_PER_LB = 0.45359237;
export const WEARABLE = 0.75; // wrist devices tend to overstate active energy (Shcherbina et al. 2017)
const PER_LB_TDEE = 8; // kcal/day a pound of weight change moves expenditure (tissue + carrying it)
const WEEKS = 26;
const WINDOW = 21; // days behind each weekly reading
const WATER_LB = 1.0; // trend-level water/glycogen noise
const PRIOR_SD = 300;
const DRIFT_SD = 50; // per week

/* ── tissue energetics ─────────────────────────────────────────────────── */

/** Share of an energy imbalance that changes lean tissue (Hall's form of Forbes' rule). */
export function leanShare(fatKg) {
  const c = (FORBES * RHO_L) / RHO_F;
  return c / (c + Math.max(fatKg, 0.5));
}

/** kcal in a pound of weight change, for a body of `weightLb` at `bodyFatPct`. */
export function kcalPerLb(weightLb, bodyFatPct = 20) {
  const fat = weightLb * KG_PER_LB * (bodyFatPct / 100);
  const p = leanShare(fat);
  return KG_PER_LB / (p / RHO_L + (1 - p) / RHO_F);
}

/* ── body fat now ──────────────────────────────────────────────────────── */

/**
 * The best body-fat figure for today: a logged one from the last 60 days
 * (mean of that week's readings), else your estimate in Settings, else a
 * rough one from BMI. `kind` says which — measured values and estimates are
 * never mixed up on the page.
 */
export function bodyFatNow(days, g, today, weightLb) {
  const keys = range(addDays(today, -59), today).filter((k) => days[k]?.bodyFat != null);
  if (keys.length) {
    const last = keys[keys.length - 1];
    const week = keys.filter((k) => daysBetween(k, last) < 7);
    const pct = week.reduce((s, k) => s + days[k].bodyFat, 0) / week.length;
    const method = days[last].bodyFatMethod || "other";
    return { pct: Math.round(pct * 10) / 10, kind: "logged", method, key: last, n: week.length };
  }
  if (g?.bodyFat > 0) return { pct: g.bodyFat, kind: "settings" };
  const est = bodyFatFromBmi(g, weightLb, today);
  return est != null ? { pct: est, kind: "bmi" } : null;
}

/* ── a robust weight trend ─────────────────────────────────────────────── */

/**
 * Theil–Sen line through [x, y] points (x in days): the median of every
 * pairwise slope, so a single unusual weigh-in can't swing it. `se` is a
 * robust standard error (from the median absolute residual).
 */
export function theilSen(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const slopes = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (pts[j][0] !== pts[i][0]) slopes.push((pts[j][1] - pts[i][1]) / (pts[j][0] - pts[i][0]));
  if (!slopes.length) return null;
  const med = (a) => { const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const slope = med(slopes);
  const intercept = med(pts.map(([x, y]) => y - slope * x));
  const res = pts.map(([x, y]) => y - (intercept + slope * x));
  const sigma = Math.max(1.4826 * med(res.map(Math.abs)), 0.2);
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const span = pts[n - 1][0] - pts[0][0];
  return { slope, intercept, se: sxx > 0 ? sigma / Math.sqrt(sxx) : Infinity, sigma, n, span, at: (x) => intercept + slope * x, outliers: res.filter((r) => Math.abs(r) > 3 * sigma).length };
}

/** Weigh-ins in a..b as [day index from a, lb]. */
function weighIns(days, a, b) {
  return range(a, b).map((k, i) => [i, days[k]?.weight]).filter((p) => p[1] != null);
}

/** The weight trend over the last `n` days ending `today`: lb/week and % of body weight a week. */
export function weightTrend(days, today, n = 28) {
  const a = addDays(today, -(n - 1));
  const pts = weighIns(days, a, today);
  const enough = pts.length >= Math.min(MIN.trend, Math.ceil(n * 0.3)) && pts.length >= 4 && (pts.at(-1)?.[0] ?? 0) - pts[0][0] >= Math.min(14, n - 4);
  if (!enough) return { enough: false, n: pts.length };
  const t = theilSen(pts);
  const now = t.at(n - 1);
  return {
    enough: true, n: t.n, span: t.span, now,
    lbPerWeek: t.slope * 7, pctPerWeek: (t.slope * 7 / now) * 100,
    lowPerWeek: (t.slope - 1.96 * t.se) * 7, highPerWeek: (t.slope + 1.96 * t.se) * 7, outliers: t.outliers,
  };
}

/* ── intake ────────────────────────────────────────────────────────────── */

const completeKcal = (days, keys) => keys.map((k) => days[k]).filter((d) => foodStatus(d) === "complete" && d.kcal != null);

/** Average intake over complete days in the last 14 days (or 28 when 14 is thin). Missing days are left out, never zero. */
export function intakeSummary(days, today) {
  for (const n of [14, 28]) {
    const keys = range(addDays(today, -(n - 1)), today);
    const done = completeKcal(days, keys);
    if (done.length >= (n === 14 ? 5 : 7)) {
      const avg = (f) => { const v = done.map((d) => d[f]).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
      return {
        n, days: done.length, partial: keys.filter((k) => foodStatus(days[k]) === "partial").length,
        missing: keys.filter((k) => foodStatus(days[k]) === "none").length,
        kcal: avg("kcal"), protein: avg("protein"), carbs: avg("carbs"), fat: avg("fat"), fiber: avg("fiber"),
      };
    }
  }
  return null;
}

/* ── the adaptive estimate ─────────────────────────────────────────────── */

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : 0; };

/** Discounted Apple active energy over the 7 days to `end` (4+ days), or null. */
function activityAt(days, end) {
  const v = range(addDays(end, -6), end).map((k) => days[k]?.activeKcal).filter((x) => x != null);
  return v.length >= 4 ? mean(v) * WEARABLE : null;
}

/**
 * The weekly estimate, oldest week first, ending today.
 * → { estimate, sd, low, high, confidence, weeks: [...], obsWeeks, baseline, bodyFat, perLb, note }
 */
export function adaptiveTdee(days, g, today) {
  const baseline = g?.maintenance > 0 ? g.maintenance : 2400;
  let x = baseline, P = PRIOR_SD ** 2;
  let prevAct = null, prevTrend = null;
  const weeks = [];
  let obsWeeks = 0, recentObs = 0, outliers = 0;
  const firstData = Object.keys(days).filter((k) => k <= today && (days[k]?.weight != null || foodStatus(days[k]) === "complete")).sort()[0];
  const nWeeks = firstData ? Math.min(WEEKS, Math.floor(daysBetween(firstData, today) / 7) + 1) : 1;
  const latest = Object.keys(days).filter((k) => k <= today && days[k]?.weight != null).sort().at(-1);
  const bf = bodyFatNow(days, g, today, latest ? days[latest].weight : null);
  const bfPct = bf?.pct ?? (g?.sex === "female" ? 30 : 20);

  for (let i = nWeeks - 1; i >= 0; i--) {
    const end = addDays(today, -7 * i);
    const a = addDays(end, -(WINDOW - 1));
    const pts = weighIns(days, a, end);
    const t = pts.length >= 4 ? theilSen(pts) : null;
    const trend = t ? t.at(WINDOW - 1) : null;

    // predict: slow drift, plus what changed in weight and (discounted, half-credited) activity
    const act = activityAt(days, end);
    if (act != null && prevAct != null) x += 0.5 * (act - prevAct);
    if (act != null) prevAct = act;
    if (trend != null && prevTrend != null) x += PER_LB_TDEE * (trend - prevTrend);
    if (trend != null) prevTrend = trend;
    P += DRIFT_SD ** 2;

    // observe, when the window holds enough of both
    const food = completeKcal(days, range(a, end)).map((d) => d.kcal);
    let obs = null, obsSd = null;
    if (food.length >= 10 && t && t.n >= 6 && t.span >= 14) {
      const intake = mean(food);
      const perLb = kcalPerLb(trend, bfPct);
      obs = intake - perLb * t.slope;
      const cover = food.length / WINDOW;
      const varI = sd(food) ** 2 / food.length + (0.05 * intake) ** 2 * (1 - cover);
      const varS = t.se ** 2 + (WATER_LB / t.span) ** 2;
      const R = (varI + perLb ** 2 * varS) * 2.5; // weekly windows overlap
      const K = P / (P + R);
      x += K * (obs - x);
      P = (1 - K) * P;
      obsSd = Math.sqrt(R / 2.5);
      obsWeeks += 1;
      if (i < 6) recentObs += 1;
      outliers += t.outliers;
    }
    const wk = completeKcal(days, range(addDays(end, -6), end)).map((d) => d.kcal);
    weeks.push({ end, estimate: x, sd: Math.sqrt(P), obs, obsSd, intake: wk.length >= 3 ? mean(wk) : null, intakeDays: wk.length, trend, activity: act });
  }

  const s = Math.sqrt(P);
  const confidence = obsWeeks >= 6 && recentObs >= 2 && s <= 160 ? "established" : obsWeeks >= 2 && recentObs >= 1 ? "developing" : "preliminary";
  const round10 = (v) => Math.round(v / 10) * 10;
  return {
    estimate: round10(x), sd: s, low: round10(x - 1.28 * s), high: round10(x + 1.28 * s),
    confidence, obsWeeks, baseline, weeks, bodyFat: bf, bodyFatPct: bfPct,
    perLb: latest ? kcalPerLb(prevTrend ?? days[latest].weight, bfPct) : kcalPerLb(170, bfPct),
    outliers,
  };
}

/* ── plateaus ──────────────────────────────────────────────────────────── */

const daysIn = (days, a, b, f) => range(a, b).map((k) => f(days[k], k)).filter((v) => v != null);
const avgOf = (days, a, b, f, min = 3) => { const v = daysIn(days, a, b, f); return v.length >= min ? mean(v) : null; };
const strengthDay = (d) => (d?.lifts?.length || (d?.workouts || []).some((w) => /strength|weight|functional|core/i.test(w.type)) ? 1 : 0);

/**
 * Has progress really stalled? Looks at the 14-, 21- and 28-day trends of
 * the weigh-ins (never single days), how long the 7-day average has stayed
 * put, and — only as possibilities — what changed: logging, intake,
 * activity, the falling cost of a lighter body, training, sleep, carbs.
 * Status: progressing · slowing · possible · confirmed · insufficient
 * (and steady/drifting for maintenance phases).
 */
export function plateau(days, g, today, energy, phase = "cut") {
  const t14 = weightTrend(days, today, 14), t21 = weightTrend(days, today, 21), t28 = weightTrend(days, today, 28);
  if (!t28.enough && !t21.enough) {
    return { status: "insufficient", factors: [], next: "Weigh in most mornings for two weeks — the trend needs about 8 weigh-ins across 14+ days.", t14, t21, t28 };
  }
  const main = t28.enough ? t28 : t21;
  const r = (t) => (t?.enough ? t.pctPerWeek : null);
  const flat = (p) => p != null && p > -0.1;
  let status;
  if (phase === "maintain") {
    status = Math.abs(main.pctPerWeek) < 0.15 ? "steady" : main.pctPerWeek < 0 ? "drifting down" : "drifting up";
  } else if (phase === "bulk") {
    status = main.pctPerWeek >= 0.1 ? "gaining" : "not gaining";
  } else if (flat(r(t28)) && flat(r(t21))) status = "confirmed";
  else if (flat(r(t14)) || (t21.enough && flat(r(t21)))) status = "possible";
  else if (main.pctPerWeek > -0.25) status = "slowing";
  else status = "progressing";

  // how long the 7-day average has stayed within ~0.6 lb of where it is now
  const avg7 = (k) => avgOf(days, addDays(k, -6), k, (d) => d?.weight, 3);
  const nowAvg = avg7(today);
  let duration = 0;
  if (nowAvg != null) {
    for (let i = 1; i <= 90; i++) {
      const v = avg7(addDays(today, -i));
      if (v == null || Math.abs(v - nowAvg) > 0.6) break;
      duration = i;
    }
  }

  // expected vs actual, from the estimated deficit
  const a14 = addDays(today, -13), b14 = today, a28 = addDays(today, -27), b28 = addDays(today, -14);
  const intakeNow = avgOf(days, a14, b14, (d) => (foodStatus(d) === "complete" ? d.kcal : null), 5);
  const intakeBefore = avgOf(days, a28, b28, (d) => (foodStatus(d) === "complete" ? d.kcal : null), 5);
  const expected = energy && intakeNow != null ? ((intakeNow - energy.estimate) * 7) / energy.perLb : null; // lb/week (negative = loss)

  const factors = [];
  const add = (id, weight, text, kind = "plausible") => factors.push({ id, weight, text, kind });
  const loggedNow = daysIn(days, a14, b14, (d) => (foodStatus(d) === "complete" ? 1 : null)).length;
  const loggedBefore = daysIn(days, a28, b28, (d) => (foodStatus(d) === "complete" ? 1 : null)).length;
  if (loggedNow < 9) add("logging", 3, `Only ${loggedNow} of the last 14 days have a complete food log, so the deficit is uncertain — missing days aren't counted as zero, but they may not match the logged ones.`, "data");
  else if (loggedBefore - loggedNow >= 4) add("logging", 2, `Fewer complete food days lately (${loggedNow} vs ${loggedBefore} the two weeks before).`, "data");
  if (intakeNow != null && intakeBefore != null && intakeNow - intakeBefore > 100) add("intake", 3, `Logged intake is up about ${Math.round(intakeNow - intakeBefore)} kcal/day on the two weeks before.`);
  const steps = (a, b) => avgOf(days, a, b, (d) => d?.steps, 5);
  const sNow = steps(a14, b14), sBefore = steps(a28, b28);
  if (sNow != null && sBefore != null && sBefore - sNow > 1500) add("steps", 2, `Daily steps are down about ${Math.round((sBefore - sNow) / 100) * 100} (from ${Math.round(sBefore).toLocaleString("en-US")} to ${Math.round(sNow).toLocaleString("en-US")}) — less everyday movement means a smaller deficit.`);
  const weeksAgo = energy?.weeks?.at(-7);
  if (energy && weeksAgo && weeksAgo.estimate - energy.estimate > 75) add("tdee", 1, `Estimated maintenance has come down about ${Math.round((weeksAgo.estimate - energy.estimate) / 10) * 10} kcal over six weeks — expected as a lighter body burns less, so the same intake is a smaller deficit. This is ordinary, not proof of "metabolic adaptation".`, "expected");
  const trainNow = daysIn(days, a14, b14, (d) => strengthDay(d)).filter(Boolean).length;
  const trainBefore = daysIn(days, addDays(today, -41), addDays(today, -14), (d) => strengthDay(d)).filter(Boolean).length / 2;
  if (trainNow - trainBefore >= 2) add("training", 1, "More strength sessions lately — new or harder training can hold extra water in muscles for a week or two.", "water");
  const sleepNow = avgOf(days, a14, b14, (d) => sleepMinutes(d), 5), sleepBefore = avgOf(days, a28, b28, (d) => sleepMinutes(d), 5);
  if (sleepNow != null && (sleepNow < 390 || (sleepBefore != null && sleepBefore - sleepNow > 40))) add("sleep", 1, `Sleep is averaging ${Math.floor(sleepNow / 60)}h ${String(Math.round(sleepNow % 60)).padStart(2, "0")}m${sleepBefore != null && sleepBefore - sleepNow > 40 ? ", down on before" : ""} — short sleep tends to raise appetite and water retention.`);
  const carbs = (a, b) => avgOf(days, a, b, (d) => (foodStatus(d) === "complete" ? d.carbs : null), 5);
  const cNow = carbs(a14, b14), cBefore = carbs(a28, b28);
  if (cNow != null && cBefore != null && cNow - cBefore > 50) add("carbs", 1, `Carbs are up about ${Math.round(cNow - cBefore)} g/day — glycogen stores water (roughly 3 g per gram), which can hide fat loss on the scale for a while.`, "water");
  if (expected != null && main.enough && expected < -0.3 && flat(r(t21))) add("expected", 2, `Your estimated deficit predicts about ${Math.abs(expected).toFixed(1)} lb/week, but the scale trend is flat — either water is masking it, or actual intake or burn differs from the estimates.`, "data");
  factors.sort((p, q) => q.weight - p.weight);

  let next;
  if (status === "progressing") next = "Keep going — the trend is moving at a sustainable pace.";
  else if (status === "slowing") next = "Nothing to change yet. Slowing is normal as you get lighter; check again in two weeks.";
  else if (status === "possible") next = "Probably temporary. Keep the plan another 1–2 weeks, weigh in most mornings, and log complete days — water can hide fat loss for that long.";
  else if (status === "confirmed") {
    const top = factors[0]?.id;
    next = top === "logging" ? "Tighten up logging first (complete days, weigh portions) before changing your targets — the data can't tell a real stall from missing logs yet."
      : top === "intake" ? "Bring intake back to your target before cutting further — that alone may restart the trend."
      : top === "steps" ? `Get daily steps back toward ${Math.round((sBefore || 0) / 500) * 500 || 8000} before eating less.`
      : top === "sleep" ? "Prioritise sleep and recovery this week before adjusting calories."
      : "If it holds for another week, make one modest change — about 100–150 kcal less, or ~2,000 more steps a day — then reassess in 2–3 weeks. No more than that.";
  } else next = phase === "maintain" ? (status === "steady" ? "Weight is steady — exactly what maintenance is for." : "Small drift; if it continues 3+ weeks, nudge intake ~100 kcal.") : phase === "bulk" ? (status === "gaining" ? "Gaining at a controlled pace." : "Not gaining yet — add ~100–150 kcal if it stays flat for 3 weeks.") : "";

  return { status, duration, t14, t21, t28, expected, intakeNow, intakeBefore, stepsNow: sNow, stepsBefore: sBefore, factors, next, nowAvg };
}

/** Earlier stretches (3+ weeks) where the 28-day trend went flat, and what was different once loss resumed. */
export function pastPlateaus(days, today, lookbackWeeks = 52) {
  const out = [];
  let run = null;
  for (let w = lookbackWeeks; w >= 0; w--) {
    const end = addDays(today, -7 * w);
    const t = weightTrend(days, end, 28);
    const flat = t.enough && t.pctPerWeek > -0.1;
    if (flat) run = run ? { ...run, end } : { start: addDays(end, -27), end, weeks: 0 };
    if (run && flat) run.weeks += 1;
    if (run && !flat && t.enough) {
      if (run.weeks >= 3) {
        const during = (f, min) => avgOf(days, run.start, run.end, f, min);
        const after = (f, min) => avgOf(days, addDays(run.end, 1), addDays(run.end, 21), f, min);
        const kcal = (d) => (foodStatus(d) === "complete" ? d.kcal : null);
        out.push({ ...run, resumedBy: end, intake: [during(kcal, 5), after(kcal, 5)], steps: [during((d) => d?.steps, 5), after((d) => d?.steps, 5)] });
      }
      run = null;
    }
  }
  return out;
}

/* ── what to eat ───────────────────────────────────────────────────────── */

export const PHASES = {
  cut: { label: "Fat loss", protein: [1.8, 2.4] },
  maintain: { label: "Maintenance", protein: [1.6, 2.2] },
  recomp: { label: "Recomposition", protein: [2.0, 2.4] },
  bulk: { label: "Lean bulk", protein: [1.6, 2.2] },
};

/** Weekly pace for a cut, % of body weight: slower as you get leaner (Helms et al. 2014: 0.5–1%/week). */
export function cutPace(bodyFatPct, chosen) {
  if (chosen > 0) return chosen;
  if (bodyFatPct == null) return 0.6;
  return bodyFatPct > 20 ? 0.8 : bodyFatPct > 15 ? 0.7 : bodyFatPct > 12 ? 0.55 : 0.45;
}

/**
 * A suggested daily calorie target for your phase, from the adaptive
 * estimate. It's only offered once the estimate is at least developing,
 * when it differs from your target by 100+ kcal, never below safe floors,
 * and never cuts further on a stall that isn't confirmed. Nothing changes
 * until you accept it.
 *
 * ctx: { days, g, today, energy, plateau, phase, strength: { status }, weight }
 */
export function calorieAdvice({ days, g, today, energy, plat, phase = "cut", strength, weight }) {
  const tdee = energy.estimate;
  const bfPct = energy.bodyFat?.pct ?? null;
  const rest = restingEnergy(g, weight, bfPct, today);
  const floor = intakeFloor(g, rest);
  const intake = intakeSummary(days, today);
  const kg = weight ? weight * KG_PER_LB : null;
  const proteinGkg = intake?.protein != null && kg ? intake.protein / kg : null;
  const range = PHASES[phase]?.protein || PHASES.cut.protein;
  const reasons = [], cautions = [];
  let target, paceText = null, pace = null, lbPerWeek = null;

  if (phase === "cut") {
    const reached = bfPct != null && energy.bodyFat?.kind === "logged" && bfPct <= (g.targetBodyFat || 10);
    pace = cutPace(bfPct, g.targetPace);
    if (strength?.status === "declining") { pace *= 0.75; cautions.push("Strength has been trending down — the suggestion uses a gentler deficit to protect training and muscle."); }
    lbPerWeek = weight ? (pace / 100) * weight : 1;
    let deficit = (lbPerWeek * (energy.perLb || kcalPerLb(weight || 180, bfPct ?? 20))) / 7;
    deficit = Math.min(deficit, 0.25 * tdee);
    target = tdee - deficit;
    paceText = `about ${(Math.round(lbPerWeek * 10) / 10).toFixed(1)} lb/week (${pace.toFixed(2).replace(/0$/, "")}% of body weight)`;
    reasons.push(`Estimated maintenance ${tdee.toLocaleString("en-US")} kcal minus a deficit for ${paceText}${g.targetPace ? " — the pace you chose" : bfPct != null ? `, set by your body fat (~${bfPct}%) — slower as you get leaner` : " — a moderate default; log your body fat and it tailors the pace"}.`);
    if (reached) cautions.push(`Your logged body fat (${bfPct}%) is at your target — consider switching to maintenance.`);
  } else if (phase === "maintain") {
    target = tdee;
    reasons.push("Maintenance: about what you burn, so weight holds steady.");
  } else if (phase === "recomp") {
    const lean = bfPct != null && bfPct < (g.sex === "female" ? 26 : 16);
    target = lean ? tdee : tdee * 0.92;
    reasons.push(lean ? "Recomposition at maintenance — lean enough that a deficit would slow muscle gain." : "Recomposition with a small (~8%) deficit, since there's still fat to lose.");
  } else {
    const surplus = Math.min(300, 0.1 * tdee);
    target = tdee + surplus;
    reasons.push(`Lean bulk: about ${Math.round(surplus / 10) * 10} kcal over maintenance, aiming for ~0.25–0.5% of body weight a week.`);
  }
  if (target < floor) { cautions.push(`Held at ${Math.round(floor).toLocaleString("en-US")} kcal — the site never suggests eating below ${rest && floor === rest ? "your estimated resting energy" : "a general safe minimum"}.`); target = floor; }

  // a stall that isn't confirmed never justifies eating less
  const current = g.kcalTarget;
  if (phase === "cut" && plat && plat.status === "possible" && target < current) {
    target = current;
    reasons.push("Weight's been flat only briefly — no cut suggested on a possible plateau; water often masks fat loss for 1–2 weeks.");
  }
  if (phase === "cut" && plat?.status === "confirmed" && target < current - 150) {
    target = current - 150;
    reasons.push("On a confirmed plateau the change is kept modest (at most 150 kcal) — reassess in 2–3 weeks.");
  }
  target = Math.round(target / 25) * 25;
  if (target < floor) target = Math.ceil(floor / 25) * 25; // rounding never dips under the floor

  if (proteinGkg != null && proteinGkg < range[0]) cautions.push(`Protein is averaging ${proteinGkg.toFixed(1)} g/kg — below the ${range[0]}–${range[1]} g/kg that best supports keeping muscle in this phase (Morton 2018; Helms 2014). Raising it matters more than cutting calories.`);
  const half = Math.max(50, Math.round(((g.kcalHigh || current + 100) - (g.kcalLow || current - 100)) / 2 / 25) * 25);
  const suggest = energy.confidence !== "preliminary" && Math.abs(target - current) >= 100;
  return {
    phase, target, low: target - half, high: target + half, current, diff: target - current, suggest,
    pace, lbPerWeek, deficit: tdee - target, floor, rest, proteinGkg,
    proteinTarget: kg ? [Math.round(range[0] * kg), Math.round(range[1] * kg)] : null,
    reasons, cautions,
  };
}
