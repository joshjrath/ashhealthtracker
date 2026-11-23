/* ──────────────────────────────────────────────────────────────────────────
   About you: the few facts the body-composition maths needs.

   Kept with your goals (so they travel with exports, backups and the
   Google Sheet). Everything is optional: without them the site still
   works from your log alone, it just says its estimates are rougher.

     sex, birthYear, heightIn        resting-energy and body-fat formulas
     bodyFat                          your own estimate, used until you log one
     targetBodyFat                    the physique goal (10% by default)
     targetPace                       % of body weight a week; 0 = chosen for you
     targetDate                       optional date to aim for
     lengthUnit                       "in" or "cm" for body measurements

   Shared by the browser and the server.
   ────────────────────────────────────────────────────────────────────────── */

export const PROFILE_DEFAULTS = {
  sex: "", // "male" · "female" · "" (not said)
  birthYear: 0,
  heightIn: 0,
  bodyFat: 0, // %, your estimate; 0 = none
  targetBodyFat: 10,
  targetPace: 0, // % of body weight per week; 0 = automatic
  targetDate: "",
  lengthUnit: "in",
};
export const PROFILE_KEYS = Object.keys(PROFILE_DEFAULTS);
export const PACES = [0, 0.5, 0.75, 1];

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const numIn = (v, lo, hi, d = 1) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10 ** d) / 10 ** d : null;
};

/** The profile fields of a goals object, checked. Anything missing or wrong falls back to the default. */
export function cleanProfile(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...PROFILE_DEFAULTS };
  if (["male", "female", ""].includes(r.sex)) out.sex = r.sex;
  const by = numIn(r.birthYear, 1900, 2100, 0);
  if (by != null) out.birthYear = by;
  const h = numIn(r.heightIn, 0, 108, 1);
  if (h != null) out.heightIn = h;
  const bf = numIn(r.bodyFat, 0, 70, 1);
  if (bf != null) out.bodyFat = bf;
  const tbf = numIn(r.targetBodyFat, 3, 50, 1);
  if (tbf != null) out.targetBodyFat = tbf;
  if (PACES.includes(Number(r.targetPace))) out.targetPace = Number(r.targetPace);
  if (r.targetDate === "" || KEY_RE.test(r.targetDate || "")) out.targetDate = r.targetDate || "";
  if (["in", "cm"].includes(r.lengthUnit)) out.lengthUnit = r.lengthUnit;
  return out;
}

/** Whole years old on `today`, or null. */
export const ageOf = (g, today) => (g?.birthYear > 0 ? Number(today.slice(0, 4)) - g.birthYear : null);

/**
 * Resting energy, kcal/day. With a body-fat figure, Katch–McArdle (from lean
 * mass); otherwise Mifflin–St Jeor (1990) from weight, height, age and sex.
 * Null when neither has what it needs.
 */
export function restingEnergy(g, weightLb, bodyFatPct, today) {
  if (!(weightLb > 0)) return null;
  const kg = weightLb * 0.45359237;
  if (bodyFatPct > 0) return Math.round(370 + 21.6 * kg * (1 - bodyFatPct / 100));
  const age = ageOf(g, today);
  if (!(g?.heightIn > 0) || age == null || !g.sex) return null;
  const cm = g.heightIn * 2.54;
  return Math.round(10 * kg + 6.25 * cm - 5 * age + (g.sex === "male" ? 5 : -161));
}

/** Lowest daily intake the site will ever suggest: general clinical floors, never below resting energy. */
export function intakeFloor(g, rest) {
  const base = g?.sex === "female" ? 1200 : 1500;
  return Math.max(base, rest || 0);
}

/**
 * A rough body-fat % from BMI, age and sex (Deurenberg 1991), only when
 * nothing better exists. Its error is several percentage points.
 */
export function bodyFatFromBmi(g, weightLb, today) {
  const age = ageOf(g, today);
  if (!(g?.heightIn > 0) || !(weightLb > 0) || age == null || !g.sex) return null;
  const bmi = (weightLb / (g.heightIn * g.heightIn)) * 703;
  return Math.round((1.2 * bmi + 0.23 * age - 10.8 * (g.sex === "male" ? 1 : 0) - 5.4) * 10) / 10;
}

/**
 * US Navy circumference method (Hodgdon & Beckett 1984), inches. Men:
 * waist and neck; women also hips. Typical error ±3–4 percentage points.
 */
export function navyBodyFat(sex, heightIn, m) {
  if (!(heightIn > 0) || !m) return null;
  const log = Math.log10;
  if (sex === "male" && m.waist > m.neck && m.neck > 0) {
    return Math.round((86.01 * log(m.waist - m.neck) - 70.041 * log(heightIn) + 36.76) * 10) / 10;
  }
  if (sex === "female" && m.waist > 0 && m.hips > 0 && m.neck > 0 && m.waist + m.hips > m.neck) {
    return Math.round((163.205 * log(m.waist + m.hips - m.neck) - 97.684 * log(heightIn) - 78.387) * 10) / 10;
  }
  return null;
}
