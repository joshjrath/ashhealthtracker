/* ──────────────────────────────────────────────────────────────────────────
   The log lives on the server (Postgres on Railway). Apple Health lands
   there through /api/ingest; this file is the page's side of the API.

   Until the first real day arrives, the page shows four months of sample
   days so every chart has something to draw. They are never saved.
   ────────────────────────────────────────────────────────────────────────── */
import { DEFAULT_GOALS, addDays } from "./metrics.js";

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

/** { days, goals, lastSync, storage, open } */
export const fetchState = () => call("GET", "/api/state");

export const api = {
  putDay: (key, day) => call("PUT", `/api/days/${key}`, day),
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
};

/** Check a file before sending it: it must look like an export. */
export function readExport(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || typeof s.days !== "object" || Array.isArray(s.days)) throw new Error("Not an Ash Health export");
  return { days: s.days, goals: { ...DEFAULT_GOALS, ...s.goals } };
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

const WORKOUT_PLAN = [
  // [type, weight, [earliest start hour, latest], [min, max] minutes, kcal per minute]
  ["Traditional Strength Training", 5, [6, 18], [40, 70], 6.5],
  ["Running", 2, [6, 8], [25, 45], 11],
  ["Walking", 2, [12, 19], [30, 60], 4.5],
  ["Cycling", 1, [7, 18], [35, 60], 9],
  ["High Intensity Interval Training", 1, [6, 18], [20, 30], 12],
];

/**
 * 120 believable days ending today, stored the way the server stores them:
 * food, sleep and creatine by hand; steps, fitness, workouts and weight
 * from Apple Health. Some days are left unlogged or half-logged on purpose,
 * so the "no data" and "partial" states have something to show.
 */
export function seed(today) {
  const r = rng(20260927);
  const n = (mu, sd) => mu + sd * (r() + r() + r() - 1.5) * 1.15;
  const N = 120;
  const days = {};
  const pickType = () => {
    let x = r() * WORKOUT_PLAN.reduce((s, w) => s + w[1], 0);
    for (const w of WORKOUT_PLAN) { if ((x -= w[1]) <= 0) return w; }
    return WORKOUT_PLAN[0];
  };
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
    if (food > 0.05) {
      manual.protein = Math.round(n(weekend ? 142 : 156, 10));
      manual.fat = Math.round(n(weekend ? 74 : 63, 7));
      const kcal = Math.round(n(weekend ? 2090 : 1985, 70) / 5) * 5;
      manual.carbs = Math.max(90, Math.round((kcal - manual.protein * 4 - manual.fat * 9) / 4));
      manual.kcal = manual.protein * 4 + manual.carbs * 4 + manual.fat * 9;
      manual.fiber = Math.round(n(31, 5));
      manual.foodDone = food > 0.13; // a few days logged only partway
      if (!manual.foodDone) {
        manual.kcal = Math.round(manual.kcal * 0.55);
        manual.protein = Math.round(manual.protein * 0.5);
        delete manual.carbs; delete manual.fat;
      }
    }
    apple.steps = Math.round(n(weekend ? 8200 : 10600, 1700) / 10) * 10;
    if (r() > 0.1) {
      const bed = 23 * 60 + n(weekend ? 45 : 5, 32);
      manual.bed = clock(bed);
      manual.wake = clock(bed + n(weekend ? 470 : 445, 28));
    }
    const works = dow === 0 || dow === 3 ? r() < 0.15 : r() < 0.86;
    const workouts = [];
    if (works) {
      const [type, , hours, mins, rate] = pickType();
      const start = Math.round((hours[0] + r() * (hours[1] - hours[0])) * 60 / 5) * 5;
      const dur = Math.round(mins[0] + r() * (mins[1] - mins[0]));
      workouts.push({
        type, start: `${key}T${clock(start)}`, end: `${key}T${clock(start + dur)}`, durationMin: dur,
        kcal: Math.round(dur * rate * (0.85 + r() * 0.3)), avgHR: Math.round(n(type === "Walking" ? 104 : 132, 8)),
      });
    }
    apple.workouts = workouts;
    const workoutMins = workouts.reduce((s, w) => s + w.durationMin, 0);
    apple.exerciseMin = Math.round(Math.max(8, workoutMins * 0.95 + n(14, 8)));
    apple.activeKcal = Math.round(n(330, 60) + workouts.reduce((s, w) => s + w.kcal, 0));
    if (i !== 29 && r() > 0.04) manual.creatine = r() < 0.97;
    days[key] = { manual, apple };
  }

  // Today reads like the example: most goals in, protein and fiber still to go.
  days[today].manual = {
    kcal: 1760, protein: 143, carbs: 176, fat: 58, fiber: 8, foodDone: false,
    bed: "22:58", wake: "07:00", creatine: true,
  };
  days[today].apple = {
    ...days[today].apple, steps: 11240, activeKcal: 482, exerciseMin: 47,
    workouts: [{ type: "Traditional Strength Training", start: `${today}T07:05`, end: `${today}T07:52`, durationMin: 47, kcal: 318, avgHR: 128 }],
  };
  // The last twelve days of protein all land, so the streak card has a story.
  for (let i = 1; i <= 12; i++) {
    const m = days[addDays(today, -i)].manual;
    if (m.protein != null && m.protein < 150) {
      const add = 150 + Math.round(r() * 12) - m.protein;
      m.protein += add;
      m.foodDone = true;
      if (m.carbs != null) m.carbs = Math.max(90, m.carbs - add);
      if (m.fat != null && m.carbs != null) m.kcal = m.protein * 4 + m.carbs * 4 + m.fat * 9;
    }
  }
  return { demo: true, goals: { ...DEFAULT_GOALS }, days };
}
