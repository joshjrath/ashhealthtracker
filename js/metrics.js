/* ──────────────────────────────────────────────────────────────────────────
   Pure calculations over the day log. Nothing here touches the DOM or
   storage, so every number on the dashboard can be tested in Node.

   A day is keyed "YYYY-MM-DD" in local time and holds whatever was logged:
     { weight, kcal, protein, carbs, fat, fiber, steps, bed, wake,
       workout, creatine }
   Sleep belongs to the morning you woke up: `bed` is the night before.
   ────────────────────────────────────────────────────────────────────────── */

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
  sleep: { label: "Sleep", unit: "", color: "#9D8CF5" },
  workout: { label: "Workout", unit: "", color: "#F27DB5" },
  creatine: { label: "Creatine", unit: "", color: "#62D6C4" },
};

/** The habits the score is built from, in the order they're shown. */
export const GOAL_IDS = ["calories", "protein", "fiber", "steps", "workout", "sleep", "creatine"];

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
  sleepHours: 7,
  tracked: [...GOAL_IDS],
};

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

/* ── sleep ─────────────────────────────────────────────────────────────── */

/** "HH:MM" → minutes after 20:00 the evening before (a night runs 20:00→20:00). */
export function nightOffset(hhmm) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const mins = h * 60 + m;
  return mins >= 1200 ? mins - 1200 : mins + 240;
}

export function sleepMinutes(day) {
  if (!day) return null;
  const bed = nightOffset(day.bed);
  const wake = nightOffset(day.wake);
  if (bed == null || wake == null) return null;
  let d = wake - bed;
  if (d <= 0) d += 1440;
  return d;
}

/* ── goals ─────────────────────────────────────────────────────────────── */

const has = (v) => v !== null && v !== undefined && v !== "";

/** true / false once there's something to judge, null when nothing's logged. */
export function goalMet(id, day, g) {
  if (!day) return null;
  switch (id) {
    case "calories": return has(day.kcal) ? day.kcal >= g.kcalLow && day.kcal <= g.kcalHigh : null;
    case "protein": return has(day.protein) ? day.protein >= g.protein : null;
    case "fiber": return has(day.fiber) ? day.fiber >= g.fiber : null;
    case "steps": return has(day.steps) ? day.steps >= g.steps : null;
    case "sleep": {
      const m = sleepMinutes(day);
      return m == null ? null : m >= g.sleepHours * 60;
    }
    case "workout": return has(day.workout) ? !!day.workout : null;
    case "creatine": return has(day.creatine) ? !!day.creatine : null;
    default: return null;
  }
}

/** The day's score: how many tracked goals are met. Unlogged counts as not met. */
export function dayScore(day, g) {
  const ids = g.tracked.filter((id) => GOAL_IDS.includes(id));
  const detail = ids.map((id) => ({ id, met: goalMet(id, day, g) }));
  const met = detail.filter((x) => x.met === true).length;
  const total = ids.length;
  return { met, total, pct: total ? met / total : 0, detail, logged: detail.some((x) => x.met !== null) };
}

/**
 * Current and best run for one goal, ending today. A today that hasn't been
 * judged yet doesn't break the streak — the day isn't over.
 */
export function streak(id, days, g, today) {
  const keys = Object.keys(days).filter((k) => k <= today).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    const met = goalMet(id, days[k], g) === true;
    if (!met) run = 0;
    else run = prev && daysBetween(prev, k) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  let current = 0;
  let k = today;
  if (goalMet(id, days[k], g) !== true) k = addDays(k, -1);
  while (goalMet(id, days[k], g) === true) {
    current += 1;
    k = addDays(k, -1);
  }
  return { current, best: Math.max(best, current) };
}

/* ── aggregates ────────────────────────────────────────────────────────── */

/** A value off a day for any metric, including derived ones. */
export function valueOf(metric, day) {
  if (!day) return null;
  switch (metric) {
    case "calories": return has(day.kcal) ? day.kcal : null;
    case "sleep": return sleepMinutes(day);
    case "workout":
    case "creatine": return has(day[metric]) ? (day[metric] ? 1 : 0) : null;
    default: return has(day[metric]) ? Number(day[metric]) : null;
  }
}

/** Mean of a metric across keys a..b inclusive, skipping unlogged days. */
export function average(metric, days, a, b) {
  let sum = 0, n = 0;
  for (const k of range(a, b)) {
    const v = valueOf(metric, days[k]);
    if (v != null) { sum += v; n += 1; }
  }
  return n ? sum / n : null;
}

/** The most recent logged weight on or before `today`. */
export function latestWeight(days, today) {
  const keys = Object.keys(days).filter((k) => k <= today && has(days[k].weight)).sort();
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

/** Where the weight goal stands. */
export function goalProgress(days, g, today) {
  const cur = latestWeight(days, today);
  const current = cur ? cur.value : g.startWeight;
  const span = g.startWeight - g.goalWeight;
  const lost = g.startWeight - current;
  return {
    start: g.startWeight,
    goal: g.goalWeight,
    current,
    lost,
    remaining: current - g.goalWeight,
    pct: span > 0 ? Math.min(1, Math.max(0, lost / span)) : 0,
  };
}

/** Last seven days against the seven before, plus eight weekly means for a sparkline. */
export function weeklyWeight(days, today) {
  const thisWeek = average("weight", days, addDays(today, -6), today);
  const lastWeek = average("weight", days, addDays(today, -13), addDays(today, -7));
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const end = addDays(today, -7 * i);
    weeks.push({ end, avg: average("weight", days, addDays(end, -6), end) });
  }
  return { thisWeek, lastWeek, change: thisWeek != null && lastWeek != null ? thisWeek - lastWeek : null, weeks };
}

/** Calories from macros, the way the composition bar splits them. */
export function macroCalories(day) {
  const p = (valueOf("protein", day) ?? 0) * 4;
  const c = (valueOf("carbs", day) ?? 0) * 4;
  const f = (valueOf("fat", day) ?? 0) * 9;
  return { protein: p, carbs: c, fat: f, total: p + c + f };
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
