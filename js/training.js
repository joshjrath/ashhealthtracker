/* ──────────────────────────────────────────────────────────────────────────
   Training: your weekly plan, and the lifting you log set by set.

   PLAN — one entry per weekday: "rest", "strength", "cardio" or "any".
   A week (Monday → Sunday) is complete when it holds at least as many
   strength days as planned strength days, as many cardio days as planned
   cardio days, and as many workout days overall as planned training days —
   so moving Tuesday's lift to Wednesday is fine, and planned rest days
   never count against you.

   LIFTS — manual.lifts on a day: [{ exercise, sets: [{ reps, weight, unit }] }].
   Volume is reps × weight (in lb). A progressive-overload increase is a
   session whose best estimated one-rep max for an exercise (Epley:
   weight × (1 + reps / 30)) beats every earlier session of that exercise.
   Only sets you logged count — Apple Health workouts carry no sets.
   ────────────────────────────────────────────────────────────────────────── */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const PLAN_TYPES = ["rest", "strength", "cardio", "any"];
export const PLAN_LABELS = { rest: "Rest", strength: "Strength", cardio: "Cardio", any: "Any workout" };

const KG = 2.2046226218;
const STRENGTH_RE = /strength|weight|functional|core|lift|power/i;

export function cleanPlan(raw) {
  if (!raw || typeof raw !== "object" || !raw.days) return null;
  const days = {};
  for (const d of WEEKDAYS) days[d] = PLAN_TYPES.includes(raw.days[d]) ? raw.days[d] : "rest";
  const since = typeof raw.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.since) ? raw.since : null;
  return { days, since };
}

/* ── dates (kept local so this file stands alone) ──────────────────────── */

const parse = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const key = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
const add = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return key(d); };
export const mondayOf = (k) => add(k, -((parse(k).getDay() + 6) % 7));
const weekdayOf = (k) => WEEKDAYS[(parse(k).getDay() + 6) % 7];

/* ── what a day's training was ─────────────────────────────────────────── */

export const isStrengthType = (type) => STRENGTH_RE.test(String(type || ""));

/** { strength, cardio, any, data } for one resolved day. */
export function dayTraining(d) {
  if (!d) return { strength: false, cardio: false, any: false, data: false };
  const ws = d.workouts || [];
  const strength = (d.lifts?.length || 0) > 0 || ws.some((w) => isStrengthType(w.type));
  const cardio = ws.some((w) => !isStrengthType(w.type));
  const any = strength || cardio || d.workout === true;
  const data = any || d.workout === false || !!d.appleFitness;
  return { strength, cardio, any, data };
}

/** Is a workout planned for this day? null when there's no plan (or it doesn't apply yet). */
export function plannedFor(plan, k) {
  if (!plan?.days || typeof k !== "string") return null;
  if (plan.since && k < plan.since) return null;
  return plan.days[weekdayOf(k)] || "rest";
}

/**
 * One week against the plan. status: "hit" · "miss" · "none" (no training
 * data at all that week — a gap, not a failure) · "pending" (the current
 * week, not yet complete) · null (the plan doesn't cover this week).
 */
export function weekStatus(days, plan, monday, today) {
  if (!plan?.days) return { status: null };
  const keys = Array.from({ length: 7 }, (_, i) => add(monday, i));
  if (plan.since && keys[6] < plan.since) return { status: null };
  const need = { strength: 0, cardio: 0, total: 0 };
  for (const k of keys) {
    const p = plannedFor(plan, k);
    if (!p || p === "rest") continue;
    need.total += 1;
    if (p === "strength") need.strength += 1;
    if (p === "cardio") need.cardio += 1;
  }
  const got = { strength: 0, cardio: 0, total: 0 };
  let data = false;
  for (const k of keys) {
    if (k > today) continue;
    const t = dayTraining(days[k]);
    if (t.data) data = true;
    if (t.strength) got.strength += 1;
    if (t.cardio) got.cardio += 1;
    if (t.any) got.total += 1;
  }
  const complete = need.total > 0 && got.strength >= need.strength && got.cardio >= need.cardio && got.total >= need.total;
  const left = {
    strength: Math.max(0, need.strength - got.strength),
    cardio: Math.max(0, need.cardio - got.cardio),
    total: Math.max(0, need.total - got.total),
  };
  const current = keys[0] <= today && today <= keys[6];
  // A week with nothing planned (all rest, or before the plan began) isn't judged at all —
  // otherwise an empty plan would hand out consistency for free.
  if (need.total === 0) return { status: null, need, got, left, keys };
  let status;
  if (complete) status = "hit";
  else if (current) status = "pending";
  else status = data ? "miss" : "none";
  return { status, need, got, left, keys };
}

/**
 * Runs of complete weeks, oldest first. A week with no data pauses a run
 * (one such week at most); a missed week ends it. The current week never
 * breaks a run. Returns the current run, the best run, and each week's
 * status with the date a run first reached each length.
 */
export function planStreak(days, plan, today, firstKey) {
  if (!plan?.days) return { current: 0, best: 0, weeks: [], reachedAt: {} };
  const start = mondayOf(plan.since && plan.since > firstKey ? plan.since : firstKey || today);
  const weeks = [];
  for (let m = start; m <= today; m = add(m, 7)) weeks.push({ monday: m, ...weekStatus(days, plan, m, today) });
  let run = 0, best = 0, gap = 0;
  const reachedAt = {}; // run length → the Sunday it was first reached
  for (const w of weeks) {
    if (w.status === "hit") {
      run += 1; gap = 0;
      if (run > best) { best = run; if (!reachedAt[run]) reachedAt[run] = add(w.monday, 6) <= today ? add(w.monday, 6) : today; }
    } else if (w.status === "miss") { run = 0; gap = 0; }
    else if (w.status === "none") { gap += 1; if (gap > 1) run = 0; }
  }
  return { current: run, best, weeks, reachedAt };
}

/* ── lifting ───────────────────────────────────────────────────────────── */

const lb = (s) => (s.unit === "kg" ? s.weight * KG : s.weight);
export const setVolume = (s) => s.reps * lb(s);
export const e1rm = (s) => lb(s) * (1 + s.reps / 30);

export function liftVolume(lift) {
  return (lift.sets || []).reduce((sum, s) => sum + setVolume(s), 0);
}

export function dayVolume(d) {
  return (d?.lifts || []).reduce((sum, l) => sum + liftVolume(l), 0);
}

/** Canonical name so "Bench press" and "bench  Press" are one exercise. */
export const exerciseKey = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Walk every logged session in date order. Returns per-day volume, each
 * day's overload increases, cumulative totals, and personal records.
 */
export function liftHistory(days, keysSorted) {
  const bestByExercise = {};
  const perDay = [];
  let volume = 0, increases = 0, sessions = 0;
  for (const k of keysSorted) {
    const lifts = days[k]?.lifts || [];
    if (!lifts.length) continue;
    sessions += 1;
    const v = lifts.reduce((s, l) => s + liftVolume(l), 0);
    volume += v;
    const prs = [];
    for (const l of lifts) {
      const ek = exerciseKey(l.exercise);
      const top = Math.max(...l.sets.map(e1rm));
      const prev = bestByExercise[ek];
      if (prev != null && top > prev * 1.005) { increases += 1; prs.push({ exercise: l.exercise, from: prev, to: top }); }
      if (prev == null || top > prev) bestByExercise[ek] = top;
    }
    perDay.push({ key: k, volume: v, cumVolume: volume, increases: prs.length, cumIncreases: increases, prs, sessions });
  }
  return { perDay, volume, increases, sessions, bestByExercise };
}

/** Exercise names you've logged, most frequent first — for autocomplete. */
export function knownExercises(days) {
  const count = {};
  const label = {};
  for (const d of Object.values(days)) {
    for (const l of d?.lifts || []) {
      const ek = exerciseKey(l.exercise);
      count[ek] = (count[ek] || 0) + 1;
      label[ek] = label[ek] || l.exercise;
    }
  }
  return Object.keys(count).sort((a, b) => count[b] - count[a]).map((k) => label[k]);
}
