/* ──────────────────────────────────────────────────────────────────────────
   The log lives in this browser's localStorage. A first visit is seeded with
   four months of sample days so every chart has something to draw; the
   banner on the page clears it the moment you want to start logging for real.
   ────────────────────────────────────────────────────────────────────────── */
import { DEFAULT_GOALS, addDays, keyOf } from "./metrics.js";

const KEY = "ash-health-v1";

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === "object" && s.days) {
        return { demo: !!s.demo, goals: { ...DEFAULT_GOALS, ...s.goals }, days: s.days };
      }
    }
  } catch {
    /* private window or corrupt value — fall through to a fresh seed */
  }
  return seed(keyOf(new Date()));
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** A blank log that keeps your goals. */
export function blank(goals = DEFAULT_GOALS) {
  return { demo: false, goals: { ...goals }, days: {} };
}

/** Accept a previously exported file, or refuse it. */
export function fromImport(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || typeof s.days !== "object") throw new Error("Not an Ash Health export");
  return { demo: false, goals: { ...DEFAULT_GOALS, ...s.goals }, days: s.days };
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

/** 120 believable days ending today, losing from 172.3 toward ~162.7. */
export function seed(today) {
  const r = rng(20260927);
  const n = (mu, sd) => mu + sd * (r() + r() + r() - 1.5) * 1.15;
  const N = 120;
  const days = {};
  for (let i = N - 1; i >= 0; i--) {
    const key = addDays(today, -i);
    const t = (N - 1 - i) / (N - 1);
    const dow = new Date(key + "T12:00").getDay();
    const weekend = dow === 0 || dow === 6;
    const d = {};

    if (r() > 0.06 || i === 0) {
      const trend = 172.3 - 9.6 * (1 - Math.pow(1 - t, 1.35));
      d.weight = +(i === N - 1 ? 172.3 : trend + n(0, 0.55) + (dow === 1 ? 0.35 : 0)).toFixed(1);
    }
    d.protein = Math.round(n(weekend ? 142 : 156, 10));
    d.fat = Math.round(n(weekend ? 74 : 63, 7));
    const kcal = Math.round(n(weekend ? 2090 : 1985, 70) / 5) * 5;
    d.carbs = Math.max(90, Math.round((kcal - d.protein * 4 - d.fat * 9) / 4));
    d.kcal = d.protein * 4 + d.carbs * 4 + d.fat * 9;
    d.fiber = Math.round(n(31, 5));
    d.steps = Math.round(n(weekend ? 8200 : 10600, 1700) / 10) * 10;
    const bed = 23 * 60 + n(weekend ? 45 : 5, 32);
    d.bed = clock(bed);
    d.wake = clock(bed + n(weekend ? 470 : 445, 28));
    d.workout = dow === 0 || dow === 3 ? r() < 0.15 : r() < 0.86;
    d.creatine = i === 29 ? false : r() < 0.97;
    days[key] = d;
  }

  // Today reads like the example: nearly done, fiber still short.
  Object.assign(days[today], {
    kcal: 1984, protein: 158, carbs: 186, fat: 64, fiber: 24, steps: 11240,
    bed: "22:58", wake: "07:00", workout: true, creatine: true,
  });
  // The last twelve days of protein all land, so the streak card has a story.
  for (let i = 1; i <= 12; i++) {
    const d = days[addDays(today, -i)];
    if (d.protein < 150) {
      const add = 150 + Math.round(r() * 12) - d.protein;
      d.protein += add;
      d.carbs = Math.max(90, d.carbs - add);
      d.kcal = d.protein * 4 + d.carbs * 4 + d.fat * 9;
    }
  }
  const p13 = days[addDays(today, -13)];
  p13.protein = 138; p13.kcal = p13.protein * 4 + p13.carbs * 4 + p13.fat * 9;

  return { demo: true, goals: { ...DEFAULT_GOALS }, days };
}
