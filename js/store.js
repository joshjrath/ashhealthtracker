/* ──────────────────────────────────────────────────────────────────────────
   The log lives on the server (Postgres on Railway). Apple Health lands
   there through /api/ingest; this file is the page's side of the API.

   Until the first real day arrives, the page shows four months of sample
   days so every chart has something to draw. They are never saved.
   ────────────────────────────────────────────────────────────────────────── */
import { DEFAULT_GOALS, addDays } from "./metrics.js";
import { nutrientsFor } from "./nutrition.js";

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

/** { days, goals, lastSync, storage, open, library, plan, achievements, lookup } */
export const fetchState = () => call("GET", "/api/state");

export const api = {
  putDay: (key, day) => call("PUT", `/api/days/${key}`, day),
  patchDay: (key, fields) => call("PATCH", `/api/days/${key}`, fields),
  deleteDay: (key) => call("DELETE", `/api/days/${key}`),
  eraseDays: () => call("DELETE", "/api/days"),
  putGoals: (goals) => call("PUT", "/api/goals", goals),
  importAll: (doc) => call("POST", "/api/import", doc),

  settings: () => call("GET", "/api/settings"),
  putPrefs: (prefs) => call("PUT", "/api/prefs", prefs),
  createToken: (name) => call("POST", "/api/tokens", { name }),
  revealToken: (id) => call("GET", `/api/tokens/${id}`),
  renameToken: (id, name) => call("PUT", `/api/tokens/${id}`, { name }),
  rotateToken: (id) => call("POST", `/api/tokens/${id}/rotate`, {}),
  deleteToken: (id) => call("DELETE", `/api/tokens/${id}`),
  changePassword: (current, next) => call("PUT", "/api/password", { current, next }),
  revokeSessions: () => call("POST", "/api/sessions/revoke", {}),
  review: (body) => call("POST", "/api/review", body),

  putItem: (kind, item) => call("PUT", `/api/items/${kind}/${encodeURIComponent(item.id)}`, item),
  deleteItem: (kind, id) => call("DELETE", `/api/items/${kind}/${encodeURIComponent(id)}`),
  searchFood: (q) => call("GET", `/api/food/search?q=${encodeURIComponent(q)}`),
  estimateFood: (text) => call("POST", "/api/food/estimate", { text }),
  putFoodApis: (body) => call("PUT", "/api/food-apis", body),
  testFoodApi: (provider) => call("POST", "/api/food-apis/test", { provider }),
  putPlan: (plan) => call("PUT", "/api/plan", plan),
  putTiers: (tiers) => call("PUT", "/api/achievement-tiers", tiers),
  ledger: (body) => call("POST", "/api/achievements/ledger", body),
};

/** Check a file before sending it: it must look like an export. */
export function readExport(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || typeof s.days !== "object" || Array.isArray(s.days)) throw new Error("Not an Ash Health export");
  const out = { days: s.days, goals: { ...DEFAULT_GOALS, ...s.goals } };
  // Newer exports also carry your saved foods, meals, rewards and training plan.
  if (s.library && typeof s.library === "object") out.library = s.library;
  if (s.plan !== undefined) out.plan = s.plan;
  return out;
}


/* ── sample data ───────────────────────────────────────────────────────── */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clock = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** The sample week: three lifting days, two cardio days, two rest days. */
export const DEMO_PLAN = { days: { mon: "strength", tue: "cardio", wed: "rest", thu: "strength", fri: "cardio", sat: "strength", sun: "rest" }, since: null };

const CARDIO = [
  // [type, weight, [earliest start hour, latest], [min, max] minutes, kcal per minute]
  ["Running", 3, [6, 8], [25, 45], 11],
  ["Cycling", 2, [7, 18], [35, 60], 9],
  ["High Intensity Interval Training", 1, [6, 18], [20, 30], 12],
  ["Walking", 1, [12, 19], [40, 60], 4.5],
];

const usda = (ref, provider = "USDA SR Legacy") => ({ kind: "database", provider, ref: String(ref), url: `https://fdc.nal.usda.gov/food-details/${ref}/nutrients` });
const g100 = { label: "100 g", amount: 100, unit: "g", grams: 100 };
const nut = (kcal, protein, carbs, fat, fiber) => ({ kcal, protein, carbs, fat, fiber });

/** Foods the sample diary is built from: per one serving, with honest sources. */
const DEMO_FOODS = [
  { id: "demo_yogurt", name: "Zero Sugar Vanilla Yogurt", brand: "Chobani", serving: { label: "1 container (150 g)", amount: 1, unit: "serving", grams: 150 }, nutrients: nut(60, 11, 5, 0, 0),
    source: { kind: "verified", provider: "USDA Branded Foods", ref: "2034567", note: "Label data from Chobani, LLC." }, lookupKey: "usda:2034567" },
  { id: "demo_oats", name: "Oats, rolled, dry", serving: { label: "½ cup (40 g)", amount: 0.5, unit: "cup", grams: 40 }, nutrients: nut(150, 5, 27, 3, 4), source: usda(173904) },
  { id: "demo_banana", name: "Bananas, raw", serving: { label: "1 medium (118 g)", amount: 1, unit: "piece", grams: 118 }, nutrients: nut(105, 1.3, 27, 0.4, 3.1), source: usda(173944) },
  { id: "demo_egg", name: "Egg, whole, cooked", serving: { label: "1 large (50 g)", amount: 1, unit: "piece", grams: 50 }, nutrients: nut(78, 6.3, 0.6, 5.3, 0), source: usda(173424) },
  { id: "demo_toast", name: "Bread, whole-wheat, toasted", serving: { label: "1 slice (29 g)", amount: 1, unit: "piece", grams: 29 }, nutrients: nut(88, 4.4, 14.9, 1.2, 2), source: usda(172688) },
  { id: "demo_shake", name: "Specular Protein Shake", serving: { label: "1 shake", amount: 1, unit: "serving" }, nutrients: nut(210, 35, 12, 4, 2), source: { kind: "custom" }, favorite: true },
  { id: "demo_chicken", name: "Chicken breast, roasted", serving: g100, nutrients: nut(165, 31, 0, 3.6, 0), source: usda(171477) },
  { id: "demo_rice", name: "Rice, white, cooked", serving: g100, nutrients: nut(130, 2.7, 28.2, 0.3, 0.4), portions: [{ label: "1 cup (158 g)", unit: "cup", amount: 1, grams: 158 }], source: usda(169757) },
  { id: "demo_broccoli", name: "Broccoli, cooked", serving: g100, nutrients: nut(35, 2.4, 7.2, 0.4, 3.3), portions: [{ label: "1 cup (156 g)", unit: "cup", amount: 1, grams: 156 }], source: usda(169967) },
  { id: "demo_salmon", name: "Salmon, Atlantic, farmed, cooked", serving: g100, nutrients: nut(206, 22.1, 0, 12.4, 0), source: usda(175168) },
  { id: "demo_potato", name: "Sweet potato, baked", serving: g100, nutrients: nut(90, 2, 20.7, 0.2, 3.3), source: usda(168483) },
  { id: "demo_pasta", name: "Pasta, cooked", serving: g100, nutrients: nut(158, 5.8, 30.9, 0.9, 1.8), portions: [{ label: "1 cup (140 g)", unit: "cup", amount: 1, grams: 140 }], source: usda(169736) },
  { id: "demo_almonds", name: "Almonds", serving: { label: "1 oz (28 g)", amount: 1, unit: "oz", grams: 28 }, nutrients: nut(164, 6, 6.1, 14.2, 3.5), source: usda(170567) },
  { id: "demo_hoagie", name: "Turkey hoagie (classic)", brand: "Wawa", serving: { label: "1 classic hoagie", amount: 1, unit: "serving", grams: 300 }, nutrients: nut(680, 38, 72, 26, null),
    source: { kind: "estimate", provider: "Claude", confidence: "medium", note: "Typical deli turkey hoagie on a 10-inch roll with cheese and mayo; Wawa's own numbers may differ." } },
];
const FOOD = Object.fromEntries(DEMO_FOODS.map((f) => [f.id, f]));

const DEMO_MEALS = [
  { id: "demo_meal_breakfast", name: "Usual breakfast", favorite: true, items: [["demo_yogurt", 1, "serving"], ["demo_oats", 1, "serving"], ["demo_banana", 1, "piece"]] },
  { id: "demo_meal_bowl", name: "Chicken rice bowl", items: [["demo_chicken", 170, "g"], ["demo_rice", 1, "cup"], ["demo_broccoli", 1, "cup"]] },
];

/** One diary entry for qty × unit of a demo food, frozen the way the page saves them. */
function entry(id, qty, unit, meal, time, n) {
  const f = FOOD[id];
  const v = nutrientsFor(f, qty, unit);
  const e = { id: `demo_e${n}`, meal, name: f.name, qty, unit, serving: f.serving, ...v, source: f.source, foodId: f.id };
  if (f.brand) e.brand = f.brand;
  if (time) e.time = time;
  return e;
}

/** Sets that climb slowly over the weeks, the way a real log does. */
const PROGRAMS = [
  [["Bench press", 3, 8, 135, 155], ["Overhead press", 3, 8, 85, 95], ["Incline dumbbell press", 3, 10, 45, 55], ["Triceps pushdown", 3, 12, 50, 60]],
  [["Back squat", 3, 6, 185, 215], ["Romanian deadlift", 3, 8, 155, 185], ["Leg press", 3, 10, 270, 320], ["Calf raise", 3, 12, 180, 200]],
  [["Deadlift", 3, 5, 225, 265], ["Barbell row", 3, 8, 135, 155], ["Lat pulldown", 3, 10, 120, 140], ["Biceps curl", 3, 12, 30, 35]],
];
function lifts(program, t, r, n) {
  return PROGRAMS[program].map(([exercise, sets, reps, from, to], i) => {
    const w = Math.round((from + (to - from) * t) / 5) * 5;
    return {
      id: `demo_l${n}_${i}`, exercise,
      sets: Array.from({ length: sets }, (_, j) => ({ reps: j === sets - 1 && r() < 0.35 ? reps - 1 : reps, weight: w, unit: "lb" })),
    };
  });
}

/**
 * 120 believable days ending today, stored the way the server stores them:
 * food, sleep, lifts and creatine by hand; steps, fitness, workouts and
 * weight from Apple Health. The last three weeks are itemised in the food
 * diary; earlier days hold quick-add totals, like a log from before the
 * diary. Some days are left unlogged or half-logged on purpose, so the
 * "no data" and "partial" states have something to show.
 */
export function seed(today) {
  const r = rng(20260927);
  const n = (mu, sd) => mu + sd * (r() + r() + r() - 1.5) * 1.15;
  const N = 120;
  const days = {};
  const uses = {};
  let eid = 0;
  const pick = (list) => {
    let x = r() * list.reduce((s, w) => s + w[1], 0);
    for (const w of list) { if ((x -= w[1]) <= 0) return w; }
    return list[0];
  };
  const PLAN_BY_DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => DEMO_PLAN.days[d]);
  let strengthCount = 0;
  for (let i = N - 1; i >= 0; i--) {
    const key = addDays(today, -i);
    const t = (N - 1 - i) / (N - 1);
    const dow = new Date(key + "T12:00").getDay();
    const weekend = dow === 0 || dow === 6;
    const manual = {}, apple = {};

    if (r() > 0.06 || i === 0) {
      const trend = 172.3 - 9.6 * (1 - Math.pow(1 - t, 1.35));
      apple.weight = +(i === N - 1 ? 172.3 : trend + n(0, 0.55) + (dow === 1 ? 0.35 : 0)).toFixed(1);
    }

    const food = r();
    const target = Math.round(n(weekend ? 2090 : 1985, 70) / 5) * 5;
    if (food > 0.05 && i > 20) {
      // Before the diary: totals typed in one go.
      manual.protein = Math.round(n(weekend ? 142 : 156, 10));
      manual.fat = Math.round(n(weekend ? 74 : 63, 7));
      manual.carbs = Math.max(90, Math.round((target - manual.protein * 4 - manual.fat * 9) / 4));
      manual.kcal = manual.protein * 4 + manual.carbs * 4 + manual.fat * 9;
      manual.fiber = Math.round(n(31, 5));
      manual.foodDone = food > 0.13; // a few days logged only partway
      if (!manual.foodDone) {
        manual.kcal = Math.round(manual.kcal * 0.55);
        manual.protein = Math.round(manual.protein * 0.5);
        delete manual.carbs; delete manual.fat;
      }
    } else if (food > 0.05 && i > 0) {
      // The diary: breakfast, lunch, a shake, and a dinner sized to land near the day's target.
      const es = [];
      const add = (id, qty, unit, meal, time) => { es.push(entry(id, qty, unit, meal, time, (eid += 1))); uses[id] = { count: (uses[id]?.count || 0) + 1, lastUsedAt: `${key}T12:00:00.000Z` }; };
      if (r() < 0.6) { add("demo_yogurt", 1, "serving", "breakfast", "07:40"); add("demo_oats", 1, "serving", "breakfast", "07:40"); add("demo_banana", 1, "piece", "breakfast", "07:40"); }
      else { add("demo_egg", 3, "piece", "breakfast", "08:10"); add("demo_toast", 2, "piece", "breakfast", "08:10"); }
      const lunch = r();
      if (lunch < 0.14) add("demo_hoagie", 1, "serving", "lunch", "12:30");
      else if (lunch < 0.5) { add("demo_chicken", 150, "g", "lunch", "12:45"); add("demo_pasta", 1, "cup", "lunch", "12:45"); }
      else { add("demo_chicken", 170, "g", "lunch", "12:40"); add("demo_rice", 1, "cup", "lunch", "12:40"); add("demo_broccoli", 1, "cup", "lunch", "12:40"); }
      add("demo_shake", 1, "serving", "snacks", "16:00");
      if (r() < 0.35) add("demo_almonds", 1, "oz", "snacks", "15:10");
      const partial = food <= 0.13;
      if (!partial) {
        const sum = (f) => es.reduce((s, e) => s + (e[f] || 0), 0);
        const left = target - sum("kcal");
        if (r() < 0.5) {
          const potato = 180;
          add("demo_potato", potato, "g", "dinner", "19:00");
          add("demo_broccoli", 1, "cup", "dinner", "19:00");
          add("demo_salmon", Math.max(110, Math.min(260, Math.round((left - 162 - 55) / 2.06 / 5) * 5)), "g", "dinner", "19:00");
        } else {
          add("demo_broccoli", 1, "cup", "dinner", "19:15");
          add("demo_rice", 150, "g", "dinner", "19:15");
          add("demo_chicken", Math.max(120, Math.min(280, Math.round((left - 55 - 195) / 1.65 / 5) * 5)), "g", "dinner", "19:15");
        }
        if (sum("protein") < 150 && i <= 12) add("demo_yogurt", 1, "serving", "snacks", "21:00");
      }
      manual.foods = es;
      manual.foodDone = !partial;
    }
    apple.steps = Math.round(n(weekend ? 8200 : 10600, 1700) / 10) * 10;
    if (r() > 0.1) {
      const bed = 23 * 60 + n(weekend ? 45 : 5, 32);
      manual.bed = clock(bed);
      manual.wake = clock(bed + n(weekend ? 470 : 445, 28));
    }
    // Workouts follow the plan: lifting days, cardio days, rest days (an occasional walk).
    const planned = PLAN_BY_DOW[dow];
    const workouts = [];
    const addWorkout = ([type, , hours, mins, rate]) => {
      const start = Math.round((hours[0] + r() * (hours[1] - hours[0])) * 60 / 5) * 5;
      const dur = Math.round(mins[0] + r() * (mins[1] - mins[0]));
      workouts.push({
        type, start: `${key}T${clock(start)}`, end: `${key}T${clock(start + dur)}`, durationMin: dur,
        kcal: Math.round(dur * rate * (0.85 + r() * 0.3)), avgHR: Math.round(n(type === "Walking" ? 104 : 132, 8)),
      });
    };
    if (planned === "strength" && r() < 0.93) {
      addWorkout(["Traditional Strength Training", 1, [6, 18], [45, 70], 6.5]);
      if (i <= 70) manual.lifts = lifts(strengthCount % 3, t, r, i);
      strengthCount += 1;
    } else if (planned === "cardio" && r() < 0.88) addWorkout(pick(CARDIO));
    else if (planned === "rest" && r() < 0.12) addWorkout(CARDIO[3]);
    apple.workouts = workouts;
    const workoutMins = workouts.reduce((s, w) => s + w.durationMin, 0);
    apple.exerciseMin = Math.round(Math.max(8, workoutMins * 0.95 + n(14, 8)));
    apple.activeKcal = Math.round(n(330, 60) + workouts.reduce((s, w) => s + w.kcal, 0));
    if (i !== 29 && r() > 0.04) manual.creatine = r() < 0.97;
    days[key] = { manual, apple };
  }

  // Today reads like the example: breakfast, lunch and a shake in; dinner, protein and fiber still to go.
  let ti = 0;
  const todayEntries = [
    entry("demo_yogurt", 1, "serving", "breakfast", "07:40", `t${(ti += 1)}`),
    entry("demo_oats", 1, "serving", "breakfast", "07:40", `t${(ti += 1)}`),
    entry("demo_banana", 1, "piece", "breakfast", "07:40", `t${(ti += 1)}`),
    entry("demo_hoagie", 1, "serving", "lunch", "12:30", `t${(ti += 1)}`),
    entry("demo_shake", 1, "serving", "snacks", "16:00", `t${(ti += 1)}`),
  ];
  for (const e of todayEntries) uses[e.foodId] = { count: (uses[e.foodId]?.count || 0) + 1, lastUsedAt: `${today}T12:00:00.000Z` };
  days[today].manual = { foods: todayEntries, foodDone: false, bed: "22:58", wake: "07:00", creatine: true };
  days[today].apple = {
    ...days[today].apple, steps: 11240, activeKcal: 482, exerciseMin: 47,
    workouts: [{ type: "Running", start: `${today}T07:05`, end: `${today}T07:52`, durationMin: 47, kcal: 318, avgHR: 138 }],
  };
  // The last twelve days of protein all land, so the streak card has a story.
  for (let i = 1; i <= 12; i++) {
    const m = days[addDays(today, -i)].manual;
    if (!m.foods && m.protein != null && m.protein < 150) {
      const add = 150 + Math.round(r() * 12) - m.protein;
      m.protein += add;
      m.foodDone = true;
      if (m.carbs != null) m.carbs = Math.max(90, m.carbs - add);
      if (m.fat != null && m.carbs != null) m.kcal = m.protein * 4 + m.carbs * 4 + m.fat * 9;
    }
  }
  const stamp = `${addDays(today, -120)}T12:00:00.000Z`;
  const library = {
    foods: DEMO_FOODS.map((f) => ({ portions: [], ...f, uses: uses[f.id] || { count: 0, lastUsedAt: null }, favorite: !!f.favorite, archived: false, createdAt: stamp, updatedAt: stamp })),
    meals: DEMO_MEALS.map((m) => ({
      id: m.id, name: m.name, favorite: !!m.favorite, archived: false, createdAt: stamp, updatedAt: stamp,
      items: m.items.map(([id, qty, unit], j) => { const e = entry(id, qty, unit, "snacks", null, `${m.id}_${j}`); delete e.meal; return e; }),
    })),
    rewards: [],
  };
  return { demo: true, goals: { ...DEFAULT_GOALS }, days, plan: DEMO_PLAN, library };
}
