/* ──────────────────────────────────────────────────────────────────────────
   Where every number is allowed to come from.

   A stored day keeps each source in its own bucket, so nothing written by
   Apple Health can land in a manual-only metric:

     { manual: { foods: [...], kcal, protein, …, bed, wake, creatine, foodDone,
                 lifts: [...], … },
       apple:  { steps, activeKcal, exerciseMin, weight, workouts: [...] },
       legacy: { … } }   ← values saved before sources were tracked

   The page never reads buckets directly: resolveDay() applies RULES and
   hands back one flat day plus `src`, the bucket each value came from.
   Server-side, cleanManual() and cleanApple() are the only doors into
   the buckets, and each lets through only the fields its source may set.

   Food is itemised in manual.foods (the diary); manual.kcal etc. are
   "quick add" totals typed without itemising (older days, the log
   dialog). A day's food totals are the two added together. Lifts
   (sets × reps × weight) live in manual.lifts.

   This file is shared by the browser and the server.
   ────────────────────────────────────────────────────────────────────────── */
import { dayFood, MEAL_IDS, UNIT_IDS } from "./nutrition.js";

/**
 * For each metric, the buckets it may be read from, in priority order.
 * Manual-only metrics never list "apple" — or "legacy", whose origin is
 * unknown; legacy values reach them only after you confirm them in
 * Settings → Your data → Review, which moves them into "manual".
 */
export const RULES = {
  // Manual only
  kcal: ["manual"],
  protein: ["manual"],
  carbs: ["manual"],
  fat: ["manual"],
  fiber: ["manual"],
  foodDone: ["manual"],
  bed: ["manual"],
  wake: ["manual"],
  creatine: ["manual"],
  // Apple Health allowed (a value you type for the same day wins)
  steps: ["manual", "apple", "legacy"],
  activeKcal: ["manual", "apple"],
  exerciseMin: ["manual", "apple"],
  // Weight: both, as before — a weigh-in you type wins over the scale's sync that day
  weight: ["manual", "apple", "legacy"],
};

export const MANUAL_ONLY = Object.keys(RULES).filter((k) => !RULES[k].includes("apple"));
export const APPLE_ALLOWED = Object.keys(RULES).filter((k) => RULES[k].includes("apple"));
export const FOOD_FIELDS = ["kcal", "protein", "carbs", "fat", "fiber"];
/** Legacy fields that stay out of every calculation until reviewed. */
export const REVIEW_FIELDS = [...FOOD_FIELDS, "bed", "wake"];

const has = (v) => v !== null && v !== undefined && v !== "";
const isBucketed = (d) => !!d && typeof d === "object" && ("manual" in d || "apple" in d || "legacy" in d);

/** One stored day → the flat day every chart reads, with `src` per field. `key` is its date. */
export function resolveDay(raw, key) {
  if (!raw) return null;
  const b = isBucketed(raw) ? raw : migrateDay(raw);
  const manual = b.manual || {};
  // Food totals = diary entries + quick-add totals, computed only from what you logged.
  const food = dayFood(manual);
  const effective = { ...manual };
  for (const n of FOOD_FIELDS) effective[n] = food.totals[n] ?? undefined;
  const bucket = { manual: effective, apple: b.apple || {}, legacy: b.legacy || {} };
  const d = { src: {}, foods: food.entries, food, lifts: Array.isArray(manual.lifts) ? manual.lifts : [] };
  if (key) d.key = key;
  for (const [field, from] of Object.entries(RULES)) {
    for (const s of from) {
      if (has(bucket[s][field])) {
        d[field] = bucket[s][field];
        d.src[field] = s;
        break;
      }
    }
  }
  // Workouts: Apple's list; a manual tick counts too; legacy only as a yes/no.
  d.workouts = Array.isArray(bucket.apple.workouts) ? bucket.apple.workouts : [];
  if (d.workouts.length || bucket.apple.workoutFlag === true) { d.workout = true; d.src.workout = "apple"; }
  if (bucket.manual.workout === true || d.lifts.length) { d.workout = true; d.src.workout = "manual"; }
  else if (d.workout === undefined && bucket.manual.workout === false) { d.workout = false; d.src.workout = "manual"; }
  else if (d.workout === undefined && has(bucket.legacy.workout)) { d.workout = !!bucket.legacy.workout; d.src.workout = "legacy"; }
  // Did the Watch sync fitness for this day? Lets "no workout" count as a miss.
  d.appleFitness = has(bucket.apple.activeKcal) || has(bucket.apple.exerciseMin);
  return d;
}

/** A pre-provenance flat day → buckets. Nothing is guessed into "manual" except creatine, which Apple never sends. */
export function migrateDay(flat) {
  const manual = {}, legacy = {};
  if (!flat || typeof flat !== "object") return { manual, apple: {}, legacy };
  if (has(flat.creatine)) manual.creatine = !!flat.creatine;
  for (const f of ["weight", "steps", "workout", ...FOOD_FIELDS]) if (has(flat[f])) legacy[f] = flat[f];
  if (has(flat.bed) && has(flat.wake)) {
    // sleepMins was only ever written by Apple Health; without it, bed/wake were typed.
    if (has(flat.sleepMins)) legacy.appleSleep = { bed: flat.bed, wake: flat.wake, sleepMins: flat.sleepMins };
    else { legacy.bed = flat.bed; legacy.wake = flat.wake; }
  }
  // The log dialog always saved creatine; Apple never did. A strong hint the day was opened by hand.
  legacy.savedByHand = has(flat.creatine);
  return { manual, apple: {}, legacy };
}

/* ── the doors into each bucket ────────────────────────────────────────── */

const TIME_RE = /^\d{1,2}:\d{2}$/;
export function num(v) {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
  return typeof v !== "boolean" && v !== null && v !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
const int = (v) => { const n = num(v); return n === undefined ? undefined : Math.round(n); };
const round1 = (v) => { const n = num(v); return n === undefined ? undefined : Math.round(n * 10) / 10; };
const clock = (v) => (typeof v === "string" && TIME_RE.test(v.trim()) && Number(v.split(":")[0]) < 24 && Number(v.split(":")[1]) < 60
  ? v.trim().padStart(5, "0") : undefined);
export function bool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "yes") return true;
  if (v === 0 || v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

const MANUAL_FIELDS = {
  weight: round1, kcal: int, protein: int, carbs: int, fat: int, fiber: int,
  steps: int, activeKcal: int, exerciseMin: int,
  bed: clock, wake: clock, workout: bool, creatine: bool, foodDone: bool,
};
const APPLE_FIELDS = { weight: round1, steps: int, activeKcal: int, exerciseMin: int, workoutFlag: bool };

function pick(raw, spec) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, fix] of Object.entries(spec)) {
    if (!(k in raw)) continue;
    const v = fix(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const SOURCE_KINDS = ["verified", "database", "estimate", "custom"];

/** A food's provenance: where its numbers came from, and whether you changed them. */
export function cleanSource(raw) {
  if (!raw || typeof raw !== "object") return { kind: "custom" };
  const out = { kind: SOURCE_KINDS.includes(raw.kind) ? raw.kind : "custom" };
  const provider = str(raw.provider, 40), ref = str(raw.ref, 80), note = str(raw.note, 300);
  const url = typeof raw.url === "string" && /^https:\/\/[^\s"<>]+$/.test(raw.url) ? raw.url.slice(0, 400) : undefined;
  if (provider) out.provider = provider;
  if (ref) out.ref = ref;
  if (url) out.url = url;
  if (note) out.note = note;
  if (raw.edited === true) out.edited = true;
  if (typeof raw.confidence === "string" && ["high", "medium", "low"].includes(raw.confidence)) out.confidence = raw.confidence;
  return out;
}

export function cleanServing(raw) {
  const out = { label: str(raw?.label, 60) || "1 serving", amount: num(raw?.amount) || 1, unit: UNIT_IDS.includes(raw?.unit) ? raw.unit : "serving" };
  const grams = num(raw?.grams), ml = num(raw?.ml);
  if (grams) out.grams = Math.round(grams * 100) / 100;
  if (ml) out.ml = Math.round(ml * 100) / 100;
  return out;
}

const nutrient = (v, d = 1) => { const n = num(v); return n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d; };

/** One diary entry. Calories are required; any other nutrient may be unknown (null). */
export function cleanFoodEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 120);
  const kcal = num(raw.kcal);
  if (!name || kcal === undefined) return null;
  const e = {
    id: str(raw.id, 48) || `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    meal: MEAL_IDS.includes(raw.meal) ? raw.meal : "snacks",
    name,
    qty: num(raw.qty) ?? 1,
    unit: UNIT_IDS.includes(raw.unit) ? raw.unit : "serving",
    serving: cleanServing(raw.serving),
    kcal: Math.round(kcal),
    protein: nutrient(raw.protein), carbs: nutrient(raw.carbs), fat: nutrient(raw.fat), fiber: nutrient(raw.fiber),
    source: cleanSource(raw.source),
  };
  const brand = str(raw.brand, 80), notes = str(raw.notes, 300), foodId = str(raw.foodId, 60), time = clock(raw.time);
  if (brand) e.brand = brand;
  if (notes) e.notes = notes;
  if (foodId) e.foodId = foodId;
  if (time) e.time = time;
  if (raw.group && typeof raw.group === "object" && str(raw.group.id, 60)) e.group = { id: str(raw.group.id, 60), name: str(raw.group.name, 80) || "Meal" };
  return e;
}

/** One exercise in a session: sets of reps × weight. */
export function cleanLift(raw) {
  if (!raw || typeof raw !== "object") return null;
  const exercise = str(raw.exercise, 80);
  if (!exercise) return null;
  const sets = (Array.isArray(raw.sets) ? raw.sets : []).slice(0, 50).map((x) => {
    const reps = int(x?.reps), weight = num(x?.weight);
    if (!reps || reps > 1000) return null;
    return { reps, weight: weight !== undefined && weight <= 3000 ? Math.round(weight * 10) / 10 : 0, unit: x?.unit === "kg" ? "kg" : "lb" };
  }).filter(Boolean);
  if (!sets.length) return null;
  const out = { id: str(raw.id, 48) || `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, exercise, sets };
  const notes = str(raw.notes, 300);
  if (notes) out.notes = notes;
  return out;
}

/** What you typed. Bed and wake only count as a pair. Food entries and lifts are checked one by one. */
export function cleanManual(raw) {
  const d = pick(raw, MANUAL_FIELDS);
  if (!d.bed || !d.wake) { delete d.bed; delete d.wake; }
  if (Array.isArray(raw?.foods)) {
    const foods = raw.foods.slice(0, 300).map(cleanFoodEntry).filter(Boolean);
    if (foods.length) d.foods = foods;
  }
  if (Array.isArray(raw?.lifts)) {
    const lifts = raw.lifts.slice(0, 60).map(cleanLift).filter(Boolean);
    if (lifts.length) d.lifts = lifts;
  }
  return d;
}

/** What Apple Health may set: fitness, steps, weight, workouts. Food and sleep can't get in. */
export function cleanApple(raw) {
  const d = pick(raw, APPLE_FIELDS);
  if (Array.isArray(raw?.workouts)) d.workouts = raw.workouts.map(cleanWorkout).filter(Boolean);
  return d;
}

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export function cleanWorkout(w) {
  if (!w || typeof w !== "object" || !STAMP_RE.test(w.start || "")) return null;
  const out = { type: String(w.type || "Workout").slice(0, 60), start: w.start };
  if (STAMP_RE.test(w.end || "")) out.end = w.end;
  for (const k of ["durationMin", "kcal", "distance", "avgHR", "maxHR"]) {
    const v = num(w[k]);
    if (v !== undefined) out[k] = Math.round(v * 10) / 10;
  }
  if (typeof w.distanceUnit === "string") out.distanceUnit = w.distanceUnit.slice(0, 8);
  if (typeof w.indoor === "boolean") out.indoor = w.indoor;
  out.id = `${out.start}|${out.type}`;
  return out;
}

/** A whole stored day, re-checked bucket by bucket (imports, reviews). */
export function cleanStored(raw) {
  const b = isBucketed(raw) ? raw : migrateDay(raw);
  const legacy = {};
  if (b.legacy && typeof b.legacy === "object") {
    for (const [k, v] of Object.entries(b.legacy)) {
      if (["weight", "steps", "workout", "savedByHand", "appleSleep", "rejected", ...REVIEW_FIELDS].includes(k)) legacy[k] = v;
    }
  }
  return { manual: cleanManual(b.manual), apple: cleanApple(b.apple), legacy };
}

/** Legacy days holding food or sleep that you haven't confirmed or rejected yet. */
export function reviewItems(rawDays) {
  const out = [];
  for (const [key, raw] of Object.entries(rawDays || {})) {
    const l = raw?.legacy;
    if (!l) continue;
    const food = FOOD_FIELDS.filter((f) => has(l[f]));
    const sleep = has(l.bed) && has(l.wake);
    if (!food.length && !sleep) continue;
    out.push({
      key,
      food: Object.fromEntries(food.map((f) => [f, l[f]])),
      sleep: sleep ? { bed: l.bed, wake: l.wake } : null,
      savedByHand: !!l.savedByHand,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : -1));
}

/** Apply a review decision to one stored day: keep → manual, reject → set aside. */
export function applyReview(raw, keep) {
  const b = cleanStored(raw);
  const moved = {};
  for (const f of REVIEW_FIELDS) {
    if (!has(b.legacy[f])) continue;
    moved[f] = b.legacy[f];
    delete b.legacy[f];
  }
  if (keep) {
    const manual = { ...moved, ...b.manual }; // anything already typed since wins
    if (FOOD_FIELDS.some((f) => has(moved[f])) && manual.foodDone === undefined) manual.foodDone = true;
    b.manual = cleanManual(manual);
  } else {
    b.legacy.rejected = { ...(b.legacy.rejected || {}), ...moved };
  }
  return b;
}
