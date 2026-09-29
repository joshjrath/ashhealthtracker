/* ──────────────────────────────────────────────────────────────────────────
   Pure calculations over the day log. Nothing here touches the DOM or
   storage, so every number on the dashboard can be tested in Node.

   `days` is always the RESOLVED map (see sources.js → resolveDay): one flat
   day per "YYYY-MM-DD", every value already filtered to the sources it may
   come from, with `src` saying which. Sleep belongs to the morning you woke
   up: `bed` is the night before.

   Three rules hold everywhere below:
   1. Missing is never zero. A goal is HIT, MISS, NO DATA ("none"), or —
      today only — PENDING. Unlogged days drop out of averages instead of
      dragging them down.
   2. Food averages use complete food days only; a half-logged day would
      make intake look lower than it was.
   3. Every average, rate and projection needs a minimum number of real
      observations, or it returns null and the page says "Not enough data yet".
   ────────────────────────────────────────────────────────────────────────── */
import { FOOD_FIELDS } from "./sources.js";

/** One colour per metric. Protein/Carbs/Fat are validated as a set (they
    share the composition bar); the rest only ever sit beside a label. */
export const METRICS = {
  weight: { label: "Weight", unit: "lb", color: "#EDEDF2" },
  calories: { label: "Calories", unit: "kcal", color: "#F3E96C" },
  protein: { label: "Protein", unit: "g", color: "#F08A78" },
  carbs: { label: "Carbs", unit: "g", color: "#45B3C8" },
  fat: { label: "Fat", unit: "g", color: "#D9B83A" },
  fiber: { label: "Fiber", unit: "g", color: "#B5D86A" },
  steps: { label: "Steps", unit: "", color: "#5CC8F0" },
  active: { label: "Active calories", short: "Active", unit: "kcal", color: "#F25C7A" },
  exercise: { label: "Exercise", unit: "min", color: "#8EDB57" },
  sleep: { label: "Sleep", unit: "", color: "#9D8CF5" },
  workout: { label: "Workout", unit: "", color: "#F27DB5" },
  creatine: { label: "Creatine", unit: "", color: "#62D6C4" },
};

/** Every goal the score can be built from, in the order they're shown. */
export const GOAL_IDS = ["calories", "protein", "fiber", "steps", "active", "exercise", "workout", "sleep", "creatine"];

export const DEFAULT_GOALS = {
  startWeight: 172.3,
  goalWeight: 145,
  kcalTarget: 2000,
  kcalLow: 1900,
  kcalHigh: 2100,
  protein: 150,
  carbs: 200,
  fat: 65,
  fiber: 30,
  steps: 10000,
  activeKcal: 600,
  exerciseMin: 60,
  sleepHours: 7,
  bedTarget: "23:00",
  wakeTarget: "07:00",
  tracked: ["calories", "protein", "fiber", "steps", "active", "exercise", "sleep", "creatine"],
};

/** Smallest samples worth reporting. Below these, the page says so instead. */
export const MIN = { avg: 3, food: 3, sleep: 3, adherence: 10, weightWeek: 3, trend: 8, eta: 14, insight: 7 };

/* ── dates ─────────────────────────────────────────────────────────────── */

export function keyOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}

/** Whole days from a to b (b − a). Noon avoids DST hour drift. */
export function daysBetween(a, b) {
  const da = parseKey(a); da.setHours(12);
  const db = parseKey(b); db.setHours(12);
  return Math.round((db - da) / 86400000);
}

/** The Monday on or before the key. */
export function mondayOf(key) {
  const dow = (parseKey(key).getDay() + 6) % 7;
  return addDays(key, -dow);
}

/** Inclusive list of keys from a to b. */
export function range(a, b) {
  const out = [];
  for (let k = a; k <= b; k = addDays(k, 1)) out.push(k);
  return out;
}

/* ── sleep (manual only) ───────────────────────────────────────────────── */

/** "HH:MM" → minutes after 20:00 the evening before (a night runs 20:00→20:00). */
export function nightOffset(hhmm) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const mins = h * 60 + m;
  return mins >= 1200 ? mins - 1200 : mins + 240;
}

/** Bedtime → wake, from what you logged. Nothing else counts as sleep. */
export function sleepMinutes(day) {
  if (!day) return null;
  const bed = nightOffset(day.bed);
  const wake = nightOffset(day.wake);
  if (bed == null || wake == null) return null;
  let d = wake - bed;
  if (d <= 0) d += 1440;
  return d;
}

/* ── food completeness ─────────────────────────────────────────────────── */

const has = (v) => v !== null && v !== undefined && v !== "";

/** "none" — nothing logged · "partial" — some, not marked finished · "complete". */
export function foodStatus(day) {
  if (!day || !FOOD_FIELDS.some((f) => has(day[f]))) return "none";
  return day.foodDone ? "complete" : "partial";
}

/* ── goals ─────────────────────────────────────────────────────────────── */

/**
 * "hit" · "miss" · "none" (no data) · "pending" (today, still reachable).
 *
 * A hit is final the moment it happens (protein can't be un-eaten). A miss
 * needs proof: a complete food log, a finished day, or a number that can
 * no longer come back into range. Anything else is none — never a miss.
 */
export function goalStatus(id, day, g, isToday = false) {
  const open = isToday ? "pending" : "none";
  const food = foodStatus(day);
  const atLeast = (v, target, finished) => (v == null ? open : v >= target ? "hit" : finished ? "miss" : open);
  switch (id) {
    case "calories": {
      const v = day?.kcal;
      if (!has(v)) return open;
      if (v > g.kcalHigh) return "miss"; // over the zone can't come back down
      if (food === "complete") return v >= g.kcalLow ? "hit" : "miss";
      return open;
    }
    case "protein": return atLeast(day?.protein, g.protein, food === "complete");
    case "fiber": return atLeast(day?.fiber, g.fiber, food === "complete");
    case "steps": return atLeast(day?.steps, g.steps, !isToday);
    case "active": return atLeast(day?.activeKcal, g.activeKcal, !isToday);
    case "exercise": return atLeast(day?.exerciseMin, g.exerciseMin, !isToday);
    case "sleep": {
      const m = sleepMinutes(day);
      return m == null ? open : m >= g.sleepHours * 60 ? "hit" : "miss";
    }
    case "workout": {
      if (day?.workout === true) return "hit";
      if (isToday) return "pending";
      // A rest day only counts as a miss when you said so, or the Watch synced that day.
      return day?.workout === false || day?.appleFitness ? "miss" : "none";
    }
    case "creatine": return day?.creatine === true ? "hit" : day?.creatine === false ? "miss" : open;
    default: return "none";
  }
}

export const trackedIds = (g) => (g.tracked || []).filter((id) => GOAL_IDS.includes(id));

/** The day's goals by status. `hit / total` is the headline; misses and gaps are kept apart. */
export function dayScore(day, g, isToday = false) {
  const detail = trackedIds(g).map((id) => ({ id, status: goalStatus(id, day, g, isToday) }));
  const count = (s) => detail.filter((x) => x.status === s).length;
  const hit = count("hit"), miss = count("miss"), none = count("none"), pending = count("pending");
  const total = detail.length;
  // "logged": at least one goal has something to judge — otherwise the day is simply no data.
  return { hit, miss, none, pending, total, judged: hit + miss, pct: total ? hit / total : 0, detail, logged: hit + miss > 0 };
}

/**
 * Current and best run for one goal. Hits extend it, a miss ends it, and a
 * day with no data pauses it — up to two in a row; a third ends it, so a
 * streak can't coast through weeks of not logging. Today never breaks it.
 */
export function streak(id, days, g, today) {
  const first = Object.keys(days).filter((k) => k <= today).sort()[0];
  if (!first) return { current: 0, best: 0 };
  const GAP = 2;
  let best = 0, run = 0, gap = 0;
  for (const k of range(first, today)) {
    const s = goalStatus(id, days[k], g, k === today);
    if (s === "hit") { run += 1; gap = 0; }
    else if (s === "miss") { run = 0; gap = 0; }
    else if (s === "none") { gap += 1; if (gap > GAP) run = 0; }
    best = Math.max(best, run);
  }
  let current = 0; gap = 0;
  for (let k = today; k >= first; k = addDays(k, -1)) {
    const s = goalStatus(id, days[k], g, k === today);
    if (s === "hit") { current += 1; gap = 0; }
    else if (s === "miss") break;
    else if (s === "none") { gap += 1; if (gap > GAP) break; }
  }
  return { current, best: Math.max(best, current) };
}

/**
 * Share of judged goal-days that were hits, over keys a..b. Today counts
 * only for goals already hit or missed. `rate` is null below MIN.adherence.
 */
export function adherence(days, g, a, b, today, ids = trackedIds(g)) {
  let hit = 0, judged = 0, none = 0;
  for (const k of range(a, b)) {
    if (k > today) break;
    for (const id of ids) {
      const s = goalStatus(id, days[k], g, k === today);
      if (s === "hit") { hit += 1; judged += 1; }
      else if (s === "miss") judged += 1;
      else if (s === "none") none += 1;
    }
  }
  return { hit, judged, none, rate: judged >= MIN.adherence ? hit / judged : null };
}

/* ── observations & averages ───────────────────────────────────────────── */

const FOOD_METRIC = { calories: "kcal", protein: "protein", carbs: "carbs", fat: "fat", fiber: "fiber" };

/**
 * The value a metric contributes to averages and charts on one day, or
 * null when that day isn't a valid observation. Food only counts from
 * complete food days.
 */
export function valueOf(metric, day, { partialFood = false } = {}) {
  if (!day) return null;
  if (metric in FOOD_METRIC) {
    const st = foodStatus(day);
    if (st === "none" || (st === "partial" && !partialFood)) return null;
    const v = day[FOOD_METRIC[metric]];
    return has(v) ? Number(v) : null;
  }
  switch (metric) {
    case "sleep": return sleepMinutes(day);
    case "active": return has(day.activeKcal) ? Number(day.activeKcal) : null;
    case "exercise": return has(day.exerciseMin) ? Number(day.exerciseMin) : null;
    case "workout":
    case "creatine": return has(day[metric]) ? (day[metric] ? 1 : 0) : null;
    default: return has(day[metric]) ? Number(day[metric]) : null;
  }
}

/** { value, n } over keys a..b; value is null when fewer than `min` observations. */
export function averageOf(metric, days, a, b, min = MIN.avg) {
  let sum = 0, n = 0;
  for (const k of range(a, b)) {
    const v = valueOf(metric, days[k]);
    if (v != null) { sum += v; n += 1; }
  }
  return { value: n >= min && n ? sum / n : null, n };
}

/** The plain mean, kept for callers that apply their own minimum. */
export function average(metric, days, a, b) {
  return averageOf(metric, days, a, b, 1).value;
}

/** Complete / partial / none counts over a..b. */
export function foodCoverage(days, a, b) {
  const c = { complete: 0, partial: 0, none: 0 };
  for (const k of range(a, b)) c[foodStatus(days[k])] += 1;
  return c;
}

/* ── weight ────────────────────────────────────────────────────────────── */

/** The most recent logged weight on or before `today`. */
export function latestWeight(days, today) {
  const keys = Object.keys(days).filter((k) => k <= today && has(days[k]?.weight)).sort();
  const k = keys[keys.length - 1];
  return k ? { key: k, value: days[k].weight } : null;
}

/** Daily weight with its trailing 7-day mean (needs two readings in the week). */
export function weightSeries(days, a, b) {
  return range(a, b).map((key) => {
    const v = valueOf("weight", days[key]);
    const win = range(addDays(key, -6), key).map((k) => valueOf("weight", days[k])).filter((x) => x != null);
    return { key, v, avg: win.length >= 2 ? win.reduce((s, x) => s + x, 0) / win.length : null };
  });
}

/**
 * Where the weight goal stands — on the 7-day average once the week has
 * three weigh-ins (a single morning's water weight shouldn't move it),
 * otherwise on the latest weigh-in.
 */
export function goalProgress(days, g, today) {
  const avg = averageOf("weight", days, addDays(today, -6), today, MIN.weightWeek).value;
  const cur = latestWeight(days, today);
  const current = avg ?? (cur ? cur.value : null);
  const basis = avg != null ? "7-day average" : cur ? "latest weigh-in" : null;
  const span = g.startWeight - g.goalWeight;
  const lost = current == null ? null : g.startWeight - current;
  return {
    start: g.startWeight,
    goal: g.goalWeight,
    current,
    basis,
    latest: cur,
    lost,
    remaining: current == null ? null : current - g.goalWeight,
    pct: span > 0 && lost != null ? Math.min(1, Math.max(0, lost / span)) : 0,
  };
}

/** Last seven days against the seven before (each needs MIN.weightWeek weigh-ins), and eight weekly means. */
export function weeklyWeight(days, today) {
  const wk = (end) => averageOf("weight", days, addDays(end, -6), end, MIN.weightWeek).value;
  const thisWeek = wk(today);
  const lastWeek = wk(addDays(today, -7));
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const end = addDays(today, -7 * i);
    weeks.push({ end, avg: wk(end) });
  }
  return { thisWeek, lastWeek, change: thisWeek != null && lastWeek != null ? thisWeek - lastWeek : null, weeks };
}

/** Least-squares slope (per day) through [x, y] points. */
function slope(pts) {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : 0;
}

/**
 * The numbers that matter once weigh-ins pile up. Each is null until there
 * is enough behind it: a 7-day average needs 3 weigh-ins that week; the
 * 30-day change needs that on both ends; the rate needs 8 weigh-ins across
 * 14+ days of the last 28; a goal date needs 14 across 21+ days, a real
 * downward trend, and an answer within two years.
 */
export function weightStats(days, g, today) {
  const avg7 = averageOf("weight", days, addDays(today, -6), today, MIN.weightWeek);
  const avg7Then = averageOf("weight", days, addDays(today, -36), addDays(today, -30), MIN.weightWeek);
  const pointsSince = (n) => range(addDays(today, -(n - 1)), today)
    .map((k) => [daysBetween(today, k), valueOf("weight", days[k])]).filter((p) => p[1] != null);
  const spanOf = (pts) => (pts.length ? pts[pts.length - 1][0] - pts[0][0] : 0);

  const p28 = pointsSince(28);
  const perWeek = p28.length >= MIN.trend && spanOf(p28) >= 14 ? slope(p28) * 7 : null;
  const direction = perWeek == null ? null : perWeek < -0.1 ? "down" : perWeek > 0.1 ? "up" : "flat";

  let eta = null;
  const p42 = pointsSince(42);
  if (p42.length >= MIN.eta && spanOf(p42) >= 21 && avg7.value != null) {
    const rate = slope(p42) * 7;
    const toGo = avg7.value - g.goalWeight;
    if (toGo <= 0) eta = { reached: true };
    else if (rate < -0.1) {
      const weeks = toGo / -rate;
      if (weeks <= 104) eta = { date: addDays(today, Math.round(weeks * 7)), weeks, rate, basis: p42.length };
    }
  }
  return {
    avg7: avg7.value, avg7n: avg7.n,
    change30: avg7.value != null && avg7Then.value != null ? avg7.value - avg7Then.value : null,
    perWeek, direction, trendN: p28.length, eta,
  };
}

/** Calories from macros, the way the composition bar splits them. Null with nothing logged. */
export function macroCalories(day) {
  if (foodStatus(day) === "none") return null;
  const g = (f) => (has(day[f]) ? Number(day[f]) : 0); // a macro left blank on a logged day adds nothing
  const p = g("protein") * 4, c = g("carbs") * 4, f = g("fat") * 9;
  return { protein: p, carbs: c, fat: f, total: p + c + f };
}

/* ── fitness ───────────────────────────────────────────────────────────── */

/** Every workout between a and b, newest last, each tagged with its day. */
export function workoutsIn(days, a, b) {
  const out = [];
  for (const k of range(a, b)) for (const w of days[k]?.workouts || []) out.push({ ...w, key: k });
  return out.sort((x, y) => (x.start < y.start ? -1 : 1));
}

const minutesOf = (w) => w.durationMin ?? null;

/** Totals for a span of days, counting only days that have data. */
export function fitnessTotals(days, a, b) {
  const ws = workoutsIn(days, a, b);
  let exercise = 0, exerciseDays = 0, active = 0, activeDays = 0, workoutDays = 0;
  for (const k of range(a, b)) {
    const d = days[k];
    if (has(d?.exerciseMin)) { exercise += d.exerciseMin; exerciseDays += 1; }
    if (has(d?.activeKcal)) { active += d.activeKcal; activeDays += 1; }
    if (d?.workout) workoutDays += 1;
  }
  const durs = ws.map(minutesOf).filter((m) => m != null);
  const types = {};
  for (const w of ws) types[w.type] = (types[w.type] || 0) + 1;
  const top = Object.entries(types).sort((x, y) => y[1] - x[1])[0];
  return {
    workouts: ws.length, workoutDays,
    exercise: exerciseDays ? exercise : null, exerciseDays,
    active: activeDays ? active : null, activeDays,
    avgDuration: durs.length >= MIN.avg ? durs.reduce((s, m) => s + m, 0) / durs.length : null,
    topType: ws.length >= MIN.avg && top ? { type: top[0], count: top[1] } : null,
    types,
  };
}

/** Consecutive days with a workout, ending today (a workout-free today doesn't break it). */
export function workoutStreak(days, today) {
  let n = 0;
  let k = days[today]?.workout ? today : addDays(today, -1);
  while (days[k]?.workout) { n += 1; k = addDays(k, -1); }
  return n;
}

/* ── weekly review ─────────────────────────────────────────────────────── */

/**
 * This week (Monday → today) against the same weekdays last week. Win and
 * gap only name goals with at least 3 judged days this week.
 */
export function weeklyReview(days, g, today) {
  const mon = mondayOf(today);
  const lastMon = addDays(mon, -7);
  const lastSame = addDays(today, -7);
  const ids = trackedIds(g);
  const perGoal = ids.map((id) => {
    const now = adherence(days, g, mon, today, today, [id]);
    const before = adherence(days, g, lastMon, lastSame, today, [id]);
    return { id, hit: now.hit, judged: now.judged, none: now.none, prevHit: before.hit, prevJudged: before.judged };
  });
  const all = adherence(days, g, mon, today, today);
  const prev = adherence(days, g, lastMon, lastSame, today);
  const rated = perGoal.filter((x) => x.judged >= 3).map((x) => ({ ...x, rate: x.hit / x.judged }));
  const win = [...rated].sort((a, b) => b.rate - a.rate || b.hit - a.hit)[0] || null;
  const gap = [...rated].sort((a, b) => a.rate - b.rate || a.hit - b.hit)[0] || null;
  const rate = all.judged ? all.hit / all.judged : null;
  const prevRate = prev.judged ? prev.hit / prev.judged : null;
  const fit = fitnessTotals(days, mon, today);
  return {
    from: mon, to: today, dayCount: daysBetween(mon, today) + 1,
    hit: all.hit, judged: all.judged, none: all.none, rate,
    perGoal,
    win,
    gap: gap && (!win || gap.id !== win.id) && gap.rate < 1 ? gap : null,
    change: rate != null && prevRate != null && all.judged >= 5 && prev.judged >= 5 ? rate - prevRate : null,
    workouts: fit.workouts, workoutDays: fit.workoutDays,
    weight: weeklyWeight(days, today),
  };
}

/* ── insights ──────────────────────────────────────────────────────────── */

const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Relationships in your own history, only where both groups have at least
 * MIN.insight days and the difference is at least 10%. Each carries its
 * sample sizes. These are correlations: nothing here says one caused the other.
 */
export function insights(days, g, today, lookback = 120) {
  const keys = range(addDays(today, -(lookback - 1)), addDays(today, -1)); // finished days only
  const out = [];
  const compare = ({ id, split, measure, a, b, fmt }) => {
    const A = [], B = [];
    for (const k of keys) {
      const side = split(k);
      if (side == null) continue;
      const v = measure(k);
      if (v == null) continue;
      (side ? A : B).push(v);
    }
    if (A.length < MIN.insight || B.length < MIN.insight) return;
    const ma = meanOf(A), mb = meanOf(B);
    if (!mb) return;
    const diff = (ma - mb) / mb;
    if (Math.abs(diff) < 0.1) return;
    out.push({ id, text: fmt(ma, mb, diff), a: `${a} (${A.length} days)`, b: `${b} (${B.length} days)`, nA: A.length, nB: B.length });
  };
  const pct = (d) => `${Math.abs(Math.round(d * 100))}% ${d > 0 ? "higher" : "lower"}`;
  const slept = (k) => { const m = sleepMinutes(days[k]); return m == null ? null : m >= g.sleepHours * 60; };

  compare({
    id: "sleep-steps", split: slept, measure: (k) => valueOf("steps", days[k]),
    a: `${g.sleepHours}h+ sleep`, b: "less sleep",
    fmt: (_a, _b, d) => `On days after ${g.sleepHours}+ hours of sleep, steps were ${pct(d)}.`,
  });
  compare({
    id: "sleep-exercise", split: slept, measure: (k) => valueOf("exercise", days[k]),
    a: `${g.sleepHours}h+ sleep`, b: "less sleep",
    fmt: (_a, _b, d) => `On days after ${g.sleepHours}+ hours of sleep, exercise minutes were ${pct(d)}.`,
  });
  compare({
    id: "weekend-kcal",
    split: (k) => { const dow = parseKey(k).getDay(); return dow === 0 || dow === 6; },
    measure: (k) => valueOf("calories", days[k]),
    a: "weekends", b: "weekdays",
    fmt: (a, b) => `Weekend calories averaged ${fmtInt(Math.abs(a - b))} kcal ${a > b ? "more" : "less"} than weekdays (complete food logs only).`,
  });
  compare({
    id: "workout-protein", split: (k) => (days[k] && foodStatus(days[k]) === "complete" ? !!days[k].workout : null),
    measure: (k) => valueOf("protein", days[k]),
    a: "workout days", b: "rest days",
    fmt: (_a, _b, d) => `Protein on workout days was ${pct(d)} than on rest days.`,
  });

  // Weeks with 4+ workouts vs fewer, against that week's change in 7-day average weight.
  const W = [], F = [];
  for (let i = 1; i <= Math.floor(lookback / 7); i++) {
    const start = addDays(mondayOf(today), -7 * i); // finished Monday–Sunday weeks
    const end = addDays(start, 6);
    if (start < keys[0]) break;
    const now = averageOf("weight", days, start, end, MIN.weightWeek).value;
    const before = averageOf("weight", days, addDays(start, -7), addDays(end, -7), MIN.weightWeek).value;
    if (now == null || before == null) continue;
    const n = fitnessTotals(days, start, end).workouts;
    (n >= 4 ? W : F).push(now - before);
  }
  if (W.length >= 4 && F.length >= 4) {
    const a = meanOf(W), b = meanOf(F);
    if (Math.abs(a - b) >= 0.2) {
      out.push({
        id: "workouts-weight",
        text: `Weeks with 4+ workouts averaged a ${Math.abs(a).toFixed(1)} lb ${a < 0 ? "drop" : "rise"} in weekly average weight, vs a ${Math.abs(b).toFixed(1)} lb ${b < 0 ? "drop" : "rise"} in other weeks.`,
        a: `4+ workouts (${W.length} weeks)`, b: `fewer (${F.length} weeks)`, nA: W.length, nB: F.length,
      });
    }
  }
  return out;
}

/* ── formatting ────────────────────────────────────────────────────────── */

export const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
export const fmt1 = (n) => (n == null ? "—" : (Math.round(n * 10) / 10).toFixed(1));
export const fmtK = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));

export function fmtDur(mins) {
  if (mins == null) return "—";
  const m = Math.round(mins);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Minutes-after-20:00 back to a clock label: 190 → "11:10p". */
export function fmtClock(offset) {
  if (offset == null) return "—";
  const mins = (Math.round(offset) + 1200) % 1440;
  const h = Math.floor(mins / 60), m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${h < 12 ? "a" : "p"}`;
}

/** "12m ago" for a Date. */
export function ago(date) {
  const m = Math.round((Date.now() - date) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
