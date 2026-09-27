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
};

/** Check a file before sending it: it must look like an export. */
export function readExport(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || typeof s.days !== "object" || Array.isArray(s.days)) throw new Error("Not an Ash Health export");
  return { days: s.days, goals: { ...DEFAULT_GOALS, ...s.goals } };
}

/* A per-browser choice, not data: "don't show me the sample days". */
const NODEMO = "ash-health-nodemo";
export const demoDismissed = () => { try { return localStorage.getItem(NODEMO) === "1"; } catch { return false; } };
export const dismissDemo = () => { try { localStorage.setItem(NODEMO, "1"); } catch { /* fine */ } };

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
