/* ──────────────────────────────────────────────────────────────────────────
   Apple Health → the "apple" bucket of each day.

   Apple Health has no web API: the data only leaves the iPhone when an app
   there sends it. Two senders are understood:

   1. Health Auto Export (iOS app, "REST API" automation, JSON):
        { data: { metrics: [{ name, units, data: [...] }], workouts: [...] } }
   2. Anything simpler, e.g. an iOS Shortcut:
        { date: "2026-09-27", steps: 11240, activeKcal: 612, ... }
        { days: { "2026-09-27": { ... } } }   or an array of { date, ... }

   Only what js/sources.js allows from Apple is kept: steps, active
   calories, exercise minutes, weight and workouts. Food and sleep are
   manual-only on this site, so Apple's versions are dropped here and never
   stored. Every metric name that arrives is reported back — accepted or
   ignored — along with the fields each workout carried, so Settings can
   show exactly what your phone is sending.
   ────────────────────────────────────────────────────────────────────────── */
import { cleanApple, num } from "../js/sources.js";

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── Apple's timestamps ────────────────────────────────────────────────── */

/**
 * "2026-09-27 06:55:12 -0700" (Health Auto Export) or ISO. The wall-clock
 * date and time are read straight off the string — they are already in the
 * phone's local time, which is the day the person lived.
 */
export function parseStamp(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const [, date, hh = "00", mm = "00", ss = "00", tz] = m;
  let ms = null;
  if (tz) {
    const iso = `${date}T${hh}:${mm}:${ss}${tz === "Z" ? "Z" : tz.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")}`;
    const t = Date.parse(iso);
    ms = Number.isNaN(t) ? null : t;
  }
  return { date, hour: Number(hh), time: `${hh}:${mm}`, ms };
}

/* ── Health Auto Export ────────────────────────────────────────────────── */

/** Metric names as the app writes them (and older spellings) → apple fields. */
const SUMS = {
  step_count: "steps",
  steps: "steps",
  active_energy: "activeKcal",
  active_energy_burned: "activeKcal",
  apple_exercise_time: "exerciseMin",
  exercise_time: "exerciseMin",
};
const WEIGHTS = new Set(["weight_body_mass", "body_mass", "weight"]);

const qty = (x) => (typeof x === "number" ? num(x) : x && typeof x === "object" && !Array.isArray(x) ? num(x.qty) : undefined);
const unitsOf = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x.units : undefined);
const toKcal = (v, units) => (/^kj$/i.test(units || "") ? v / 4.184 : v);
const toPounds = (v, units) => (/^kg$/i.test(units || "") ? v * 2.20462262 : v);

/** One workout as the app sends it → the few fields worth keeping. */
export function parseWorkout(w) {
  const st = parseStamp(w?.start ?? w?.startDate ?? w?.date);
  if (!st) return null;
  const en = parseStamp(w.end ?? w.endDate);
  let durationMin;
  if (st.ms != null && en?.ms != null && en.ms > st.ms) durationMin = (en.ms - st.ms) / 60000;
  else {
    const d = qty(w.duration);
    if (d !== undefined) durationMin = d > 300 ? d / 60 : d; // seconds in current exports, minutes in some old ones
  }
  let kcal = qty(w.activeEnergyBurned) ?? qty(w.activeEnergy);
  let kcalUnits = unitsOf(w.activeEnergyBurned) ?? unitsOf(w.activeEnergy);
  if (kcal === undefined && Array.isArray(w.activeEnergy)) {
    kcal = w.activeEnergy.reduce((s, e) => s + (num(e?.qty) ?? 0), 0) || undefined;
    kcalUnits = w.activeEnergy[0]?.units;
  }
  const type = String(w.name ?? w.workoutActivityType ?? w.type ?? "Workout").replace(/^HKWorkoutActivityType/, "").trim() || "Workout";
  return {
    type,
    start: `${st.date}T${st.time}`,
    end: en ? `${en.date}T${en.time}` : undefined,
    durationMin,
    kcal: kcal !== undefined ? toKcal(kcal, kcalUnits) : undefined,
    distance: qty(w.distance),
    distanceUnit: unitsOf(w.distance),
    avgHR: qty(w.avgHeartRate) ?? qty(w.heartRate?.avg) ?? qty(w.averageHeartRate),
    maxHR: qty(w.maxHeartRate) ?? qty(w.heartRate?.max),
    indoor: typeof w.isIndoor === "boolean" ? w.isIndoor : undefined,
  };
}

export function fromHealthAutoExport(payload) {
  const root = payload?.data ?? payload;
  const report = { accepted: {}, ignored: {}, workoutFields: {}, workouts: 0 };
  const sums = {}; // key → field → total
  const weights = {}; // key → { t, v }
  const workouts = {}; // key → [workout]

  for (const metric of root?.metrics || []) {
    const name = String(metric?.name || "").toLowerCase();
    const count = Array.isArray(metric?.data) ? metric.data.length : 0;
    const field = SUMS[name];
    const isWeight = WEIGHTS.has(name);
    if (!field && !isWeight) {
      report.ignored[name] = (report.ignored[name] || 0) + count;
      continue;
    }
    report.accepted[name] = (report.accepted[name] || 0) + count;
    for (const e of metric.data || []) {
      const st = parseStamp(e.date ?? e.startDate);
      const v = num(e.qty ?? e.Avg ?? e.avg);
      if (!st || v === undefined) continue;
      if (isWeight) {
        const t = st.ms ?? 0;
        if (!weights[st.date] || t >= weights[st.date].t) weights[st.date] = { t, v: toPounds(v, metric.units) };
      } else {
        const add = field === "activeKcal" ? toKcal(v, metric.units) : v;
        (sums[st.date] ||= {})[field] = (sums[st.date][field] || 0) + add;
      }
    }
  }

  for (const w of root?.workouts || []) {
    for (const k of Object.keys(w || {})) report.workoutFields[k] = (report.workoutFields[k] || 0) + 1;
    const p = parseWorkout(w);
    if (!p) continue;
    report.workouts += 1;
    (workouts[p.start.slice(0, 10)] ||= []).push(p);
  }

  const days = {};
  const keys = new Set([...Object.keys(sums), ...Object.keys(weights), ...Object.keys(workouts)]);
  for (const key of keys) {
    if (!KEY_RE.test(key)) continue;
    const d = cleanApple({
      ...(sums[key] || {}),
      ...(weights[key] ? { weight: weights[key].v } : {}),
      ...(workouts[key] ? { workouts: dedupe(workouts[key]) } : {}),
    });
    if (Object.keys(d).length) days[key] = d;
  }
  return { days, report };
}

function dedupe(list) {
  const seen = new Map();
  for (const w of list) seen.set(`${w.start}|${w.type}`, w);
  return [...seen.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
}

/* ── entry point ───────────────────────────────────────────────────────── */

const GENERIC_ALIASES = { kcalActive: "activeKcal", active: "activeKcal", exercise: "exerciseMin", workout: "workoutFlag" };

/**
 * Any accepted payload → { days: { key: appleFields }, report }.
 * Throws on a shape it doesn't know.
 */
export function parseIngest(body) {
  if (!body || typeof body !== "object") throw new Error("Expected a JSON object");

  const hae = body.data && (Array.isArray(body.data.metrics) || Array.isArray(body.data.workouts));
  if (hae || Array.isArray(body.metrics)) return fromHealthAutoExport(body);

  const days = {};
  const report = { accepted: {}, ignored: {}, workoutFields: {}, workouts: 0 };
  const add = (key, raw) => {
    const k = typeof key === "string" ? parseStamp(key)?.date : null;
    if (!k || !KEY_RE.test(k) || !raw || typeof raw !== "object") return;
    const renamed = {};
    for (const [f, v] of Object.entries(raw)) {
      if (f === "date") continue;
      renamed[GENERIC_ALIASES[f] || f] = v;
    }
    if (Array.isArray(renamed.workouts)) renamed.workouts = renamed.workouts.map((w) => parseWorkout(w)).filter(Boolean);
    const d = cleanApple(renamed);
    for (const f of Object.keys(renamed)) {
      const bucket = f in d ? report.accepted : report.ignored;
      bucket[f] = (bucket[f] || 0) + 1;
    }
    if (d.workouts) report.workouts += d.workouts.length;
    if (Object.keys(d).length) days[k] = { ...(days[k] || {}), ...d };
  };
  if (Array.isArray(body)) body.forEach((d) => add(d?.date, d));
  else if (body.days && typeof body.days === "object" && !Array.isArray(body.days)) {
    for (const [k, d] of Object.entries(body.days)) add(k, d);
  } else if (Array.isArray(body.days)) body.days.forEach((d) => add(d?.date, d));
  else if (body.date) add(body.date, body);
  else throw new Error("Unrecognised payload: send Health Auto Export JSON, or { date, steps, activeKcal, ... }");
  return { days, report };
}
