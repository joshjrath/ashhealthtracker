/* ──────────────────────────────────────────────────────────────────────────
   Where every number is allowed to come from.

   A stored day keeps each source in its own bucket, so nothing written by
   Apple Health can land in a manual-only metric:

     { manual: { kcal, protein, …, bed, wake, creatine, foodDone, … },
       apple:  { steps, activeKcal, exerciseMin, weight, workouts: [...] },
       legacy: { … } }   ← values saved before sources were tracked

   The page never reads buckets directly: resolveDay() applies RULES and
   hands back one flat day plus `src`, the bucket each value came from.
   Server-side, cleanManual() and cleanApple() are the only doors into
   the buckets, and each lets through only the fields its source may set.

   This file is shared by the browser and the server.
   ────────────────────────────────────────────────────────────────────────── */

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

/** One stored day → the flat day every chart reads, with `src` per field. */
export function resolveDay(raw) {
  if (!raw) return null;
  const b = isBucketed(raw) ? raw : migrateDay(raw);
  const bucket = { manual: b.manual || {}, apple: b.apple || {}, legacy: b.legacy || {} };
  const d = { src: {} };
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
  if (bucket.manual.workout === true) { d.workout = true; d.src.workout = "manual"; }
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

/** What you typed. Bed and wake only count as a pair. */
export function cleanManual(raw) {
  const d = pick(raw, MANUAL_FIELDS);
  if (!d.bed || !d.wake) { delete d.bed; delete d.wake; }
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
