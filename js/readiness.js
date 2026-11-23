/* ──────────────────────────────────────────────────────────────────────────
   Recovery & training readiness: how well you seem to be recovering, from
   sleep, resting heart rate and HRV (when Apple Health sends them),
   training load, consecutive training days, lifting performance, the
   energy deficit and protein, and your own check-ins.

   PRINCIPLES
   - Your own baseline, not population norms. Resting HR and HRV are judged
     against your previous ~4 weeks, using the median of the last 3 (RHR) or
     7 (HRV) days — single mornings swing a lot (Plews et al. 2013; Buchheit
     2014), so most of the days have to agree.
     Apple Health's HRV is SDNN, noisier than the rMSSD most research uses.
   - A change has to be bigger than normal variation (half a standard
     deviation of your day-to-day values for HRV, the larger of 3 bpm or one
     SD for RHR) to count.
   - Training load = working sets + other workout minutes, 7 days against
     the weekly average of the 21 before. A jump past ~1.5× is flagged as a
     spike (an imperfect marker — Impellizzeri 2020 — so it's one signal).
   - No single indicator decides. "Recovery recommended" needs two
     sustained signals; one gives "moderate fatigue". Check-ins count, but a
     single rough morning doesn't call for a rest day.
   - It's an estimate to help you decide, not a measure of physiology and
     not a diagnosis.
   ────────────────────────────────────────────────────────────────────────── */
import { addDays, range, sleepMinutes, nightOffset } from "./metrics.js";
import { dayTraining, plannedFor, isStrengthType, PLAN_LABELS } from "./training.js";
import { workingSets } from "./liftstats.js";

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => { const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const vals = (days, keys, f) => keys.map((k) => f(days[k])).filter((v) => v != null && Number.isFinite(v));

export const STATUS = {
  good: { word: "Well recovered", cls: "ok" },
  moderate: { word: "Moderate fatigue", cls: "mid" },
  recover: { word: "Recovery recommended", cls: "bad" },
  insufficient: { word: "Not enough data", cls: "none" },
};

/** A day's training load: working sets plus minutes of other workouts (and their count). */
export function dayLoad(d) {
  if (!d) return { sets: 0, minutes: 0, load: 0 };
  const sets = (d.lifts || []).reduce((s, l) => s + workingSets(l.sets).length, 0);
  const minutes = (d.workouts || []).filter((w) => !isStrengthType(w.type) || !d.lifts?.length).reduce((s, w) => s + (w.durationMin || 0), 0);
  // a working set ≈ 3 hard minutes; a lifting workout logged only in Apple Health counts by its minutes
  return { sets, minutes, load: sets * 3 + minutes };
}

/** Acute (7-day) load against the weekly average of the 21 days before. */
export function loadRatio(days, today) {
  const acute = range(addDays(today, -6), today).reduce((s, k) => s + dayLoad(days[k]).load, 0);
  const prior = range(addDays(today, -27), addDays(today, -7)).reduce((s, k) => s + dayLoad(days[k]).load, 0) / 3;
  const trainedPrior = range(addDays(today, -27), addDays(today, -7)).filter((k) => dayLoad(days[k]).load > 0).length;
  return { acute, chronic: prior, ratio: prior > 0 && trainedPrior >= 4 ? acute / prior : null };
}

/** A heart signal against your own baseline: { now, base, sd, delta, n, flag }. */
function heartSignal(days, today, field, window, higherIsWorse) {
  const recent = vals(days, range(addDays(today, -(window - 1)), today), (d) => d?.[field]);
  const baseKeys = range(addDays(today, -34), addDays(today, -window));
  const base = vals(days, baseKeys, (d) => d?.[field]);
  if (recent.length < Math.min(2, window) || base.length < 10) return { n: base.length, enough: false };
  const tf = field === "hrv" ? Math.log : (v) => v; // HRV judged on a log scale
  const b = base.map(tf), r = recent.map(tf);
  // the window's median, so one extreme morning can't make a trend: most of the days have to agree
  const m = mean(b), s = sd(b) || 0.0001, now = median(r);
  const delta = now - m;
  const thr = field === "hrv" ? 0.5 * s : Math.max(3, s);
  const bad = higherIsWorse ? delta > thr : delta < -thr;
  const good = higherIsWorse ? delta < -thr : delta > thr;
  const today1 = days[today]?.[field];
  const single = today1 != null && (higherIsWorse ? tf(today1) - m > (field === "hrv" ? s : Math.max(5, 2 * s)) : tf(today1) - m < -(field === "hrv" ? s : 2 * s));
  return {
    enough: true, now: field === "hrv" ? Math.exp(now) : now, base: field === "hrv" ? Math.exp(m) : m,
    pct: field === "hrv" ? (Math.exp(delta) - 1) * 100 : delta, flag: bad ? "bad" : good ? "good" : "ok", single: single && !bad, n: base.length,
  };
}

/**
 * Readiness on a day, from everything up to and including it.
 * ctx: { days, g, today, strengthStatus, deficitPct, proteinGkg, lossPct }
 */
export function readiness({ days, g, today, strengthStatus = null, deficitPct = null, proteinGkg = null, lossPct = null }) {
  const signals = [];
  const add = (id, level, text, kind = "objective") => signals.push({ id, level, text, kind });
  let inputs = 0;

  // sleep: last three nights against your target, and how regular bedtimes are
  const need = (g.sleepHours || 8) * 60;
  const nights = vals(days, range(addDays(today, -2), today), sleepMinutes);
  const week = vals(days, range(addDays(today, -6), today), sleepMinutes);
  let sleep = null;
  if (nights.length >= 2) {
    inputs += 1;
    sleep = mean(nights);
    const short = need - sleep;
    const h = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
    if (short >= 60) add("sleep", "strong", `Sleep has averaged ${h(sleep)} over the last ${nights.length} nights — about ${Math.round(short)} min under your ${g.sleepHours || 8} h goal.`);
    else if (short >= 30) add("sleep", "mild", `Sleep a little short: ${h(sleep)} on average the last ${nights.length} nights.`);
    else add("sleep", "good", `Sleep on target: ${h(sleep)} on average the last ${nights.length} nights.`);
    const beds = vals(days, range(addDays(today, -6), today), (d) => nightOffset(d?.bed));
    if (beds.length >= 5 && sd(beds) > 75) add("sleepreg", "mild", `Bedtimes have varied by more than an hour this week — a regular schedule helps sleep quality.`);
  }

  // resting heart rate (3-day) and HRV (7-day) against your last ~4 weeks
  const rhr = heartSignal(days, today, "restingHR", 3, true);
  const hrv = heartSignal(days, today, "hrv", 7, false);
  if (rhr.enough) {
    inputs += 1;
    if (rhr.flag === "bad") add("rhr", "strong", `Resting heart rate is up ${rhr.pct.toFixed(0)} bpm on your usual (${Math.round(rhr.now)} vs ~${Math.round(rhr.base)}, last 3 days).`);
    else if (rhr.single) add("rhr", "mild", `Resting heart rate was high this morning, but the last few days are normal — one reading isn't a trend.`);
    else add("rhr", "good", `Resting heart rate is at your usual level (~${Math.round(rhr.now)} bpm).`);
  }
  if (hrv.enough) {
    inputs += 1;
    if (hrv.flag === "bad") add("hrv", "strong", `HRV is ${Math.abs(hrv.pct).toFixed(0)}% below your usual over most of the last week — a common sign of accumulated stress.`);
    else if (hrv.single) add("hrv", "mild", "HRV was low this morning, but the rest of the week is in your normal range.");
    else add("hrv", "good", `HRV is in your normal range (last 7 days${hrv.flag === "good" ? ", slightly above usual" : ""}).`);
  }

  // training load and consecutive days
  const lr = loadRatio(days, today);
  const trainedRecently = range(addDays(today, -13), today).some((k) => dayTraining(days[k]).any);
  if (trainedRecently) inputs += 1;
  if (lr.ratio != null) {
    if (lr.ratio >= 1.5) add("load", "strong", `This week's training load is ${lr.ratio.toFixed(1)}× your recent weekly average — a sharp jump.`);
    else if (lr.ratio >= 1.3) add("load", "mild", `Training load is up ${Math.round((lr.ratio - 1) * 100)}% on your recent weeks.`);
  }
  let run = 0;
  for (const k of [...range(addDays(today, -13), today)].reverse()) { if (dayTraining(days[k]).any) run += 1; else break; }
  const planned = plannedFor(g.plan, today);
  if (run >= 7) add("streak", run >= 9 ? "strong" : "mild", `${run} days in a row without a rest day${g.plan ? " — your plan has one each week" : ""}.`);

  // lifting performance
  if (strengthStatus === "declining") add("perf", "strong", "Lifting performance has dropped over several sessions on more than one lift.");
  else if (strengthStatus === "improving" || strengthStatus === "stable") add("perf", "good", `Lifts are ${strengthStatus === "improving" ? "improving" : "holding steady"}.`);

  // energy and protein: context, not fatigue by themselves
  if (deficitPct != null && deficitPct > 25) add("deficit", "mild", `The deficit is large (~${Math.round(deficitPct)}% of maintenance) — recovery usually suffers first.`, "context");
  if (lossPct != null && lossPct > 1) add("loss", "mild", `Losing ${lossPct.toFixed(1)}% of body weight a week — fast enough to strain recovery.`, "context");
  if (proteinGkg != null && proteinGkg < 1.6) add("protein", "mild", `Protein is ${proteinGkg.toFixed(1)} g/kg — under the 1.6+ g/kg that supports recovery in a deficit.`, "context");

  // how you feel: today, and the last three days
  const ci = days[today]?.checkin;
  const ci3 = range(addDays(today, -2), today).map((k) => days[k]?.checkin).filter(Boolean);
  const avg = (f) => mean(ci3.map((c) => c[f]).filter((v) => v != null));
  if (ci) inputs += 1;
  if (ci3.length) {
    const fat = avg("fatigue"), sore = avg("soreness"), en = avg("energy"), mot = avg("motivation");
    const rough = [fat != null && fat >= 4, sore != null && sore >= 4, en != null && en <= 2, mot != null && mot <= 2].filter(Boolean).length;
    if (rough >= 2 && ci3.length >= 2) add("feel", "strong", `You've reported feeling run down for ${ci3.length} days (${[fat >= 4 && "fatigue", sore >= 4 && "soreness", en <= 2 && "low energy", mot <= 2 && "low motivation"].filter(Boolean).join(", ")}).`, "subjective");
    else if (rough >= 1) add("feel", "mild", `Check-in: ${[fat >= 4 && "high fatigue", sore >= 4 && "sore", en <= 2 && "low energy", mot <= 2 && "low motivation"].filter(Boolean).join(", ")}${ci3.length === 1 ? " today" : ""}.`, "subjective");
    else add("feel", "good", "Check-ins say you feel fine.", "subjective");
  }

  const strong = signals.filter((s) => s.level === "strong" && s.kind !== "context").length;
  const mild = signals.filter((s) => s.level === "mild").length;
  let status;
  if (inputs < 2) status = "insufficient";
  else if (strong >= 2 || (strong >= 1 && mild >= 3)) status = "recover";
  else if (strong === 1 || mild >= 2) status = "moderate";
  else status = "good";
  const confidence = inputs >= 4 ? "higher" : inputs === 3 ? "moderate" : "low";
  return { status, signals, strong, mild, inputs, confidence, sleep, rhr, hrv, load: lr, run, planned, today };
}

/**
 * What to do today, from the status and what's planned. Never a rest day
 * from one signal. Returns [{ text, kind }].
 */
export function readinessAdvice(r, { strengthStatus, deficitPct } = {}) {
  const out = [];
  const plannedLift = r.planned && r.planned !== "rest" && r.planned !== "cardio";
  const label = r.planned ? PLAN_LABELS[r.planned] : null;
  if (r.status === "insufficient") {
    out.push({ kind: "info", text: "Log last night's sleep and a quick check-in for a read on recovery. Resting HR and HRV join in once Apple Health has sent a few weeks." });
    return out;
  }
  if (r.planned === "rest") out.push({ kind: "good", text: "Planned rest day — light walking or mobility is fine. Rest days are part of the plan." });
  else if (r.status === "good") out.push({ kind: "good", text: plannedLift ? `Train as planned${label && label !== "Strength" && label !== "Any workout" ? ` — ${label.toLowerCase()} day` : ""}. Recovery looks fine; push for your usual reps.` : "Recovery looks fine — train as you'd planned." });
  else if (r.status === "moderate") out.push({ kind: "watch", text: plannedLift ? `Train, but ease off a little: stop 1–2 reps short of failure and drop the last set on big compound lifts.` : "Keep today's session moderate." });
  else out.push({ kind: "watch", text: `Several signals point the same way. ${plannedLift ? `Cut today's ${label && label !== "Strength" ? label.toLowerCase() + " " : ""}volume by about a third to a half, or swap it for an easy walk.` : "Make today easy or a rest day."} If it lasts 3+ days with lifts down, a lighter week (deload) usually helps more than pushing.` });
  if (r.signals.some((s) => s.id === "sleep" && s.level !== "good")) out.push({ kind: "watch", text: "Make sleep the priority tonight — it's the cheapest recovery there is." });
  if (r.signals.some((s) => s.id === "streak" && s.level === "strong")) out.push({ kind: "watch", text: "Take the rest day your plan has this week." });
  if ((r.status === "recover" || r.status === "moderate") && strengthStatus === "declining" && deficitPct != null && deficitPct > 15) out.push({ kind: "info", text: "Recovery and lifts are both down while you're in a deficit — consider a week at maintenance (see the forecast's diet-break option), or a slightly smaller deficit." });
  return out.slice(0, 3);
}

/** Readiness for each of the last `n` days (each from data up to that day). */
export function readinessHistory(ctx, n = 28) {
  return range(addDays(ctx.today, -(n - 1)), ctx.today).map((k) => ({ key: k, ...readiness({ ...ctx, today: k }) }));
}

/** Last night's sleep before each lifting session, against how the session went (% vs that lift's recent level). */
export function sleepVsPerformance(days, today, exercises, lookback = 120) {
  const from = addDays(today, -lookback);
  const byDay = {};
  for (const e of exercises) {
    const s = e.sessions;
    for (let i = 3; i < s.length; i++) {
      if (s[i].key < from || s[i].metric !== "e1rm") continue;
      const prev = s.slice(Math.max(0, i - 4), i).map((x) => x.value);
      const ref = prev.reduce((a, b) => a + b, 0) / prev.length;
      (byDay[s[i].key] ||= []).push((s[i].value / ref - 1) * 100);
    }
  }
  return Object.entries(byDay).map(([key, v]) => ({ key, sleep: sleepMinutes(days[key]), perf: v.reduce((a, b) => a + b, 0) / v.length, n: v.length })).filter((p) => p.sleep != null);
}
