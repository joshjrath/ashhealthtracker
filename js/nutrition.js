/* ──────────────────────────────────────────────────────────────────────────
   The food diary's arithmetic. Pure functions, shared by the page, the
   server and the tests.

   A FOOD (saved, looked up, estimated or custom) describes one serving:
     { name, brand, serving: { label, amount, unit, grams?, ml? },
       nutrients: { kcal, protein, carbs, fat, fiber },   ← per ONE serving
       portions: [{ label, unit, amount, grams }],         ← other measures
       source: { kind, provider, ref, url, note, edited } }
   A nutrient the source doesn't list is null — unknown, never zero.

   An ENTRY is a food eaten on a day, with its numbers already scaled and
   frozen, so editing a saved food later never rewrites your history:
     { id, meal, name, brand, qty, unit, serving, kcal, protein, carbs,
       fat, fiber, time, notes, foodId, source, group }
   ────────────────────────────────────────────────────────────────────────── */

export const MEALS = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "dinner", label: "Dinner" },
  { id: "snacks", label: "Snacks" },
];
export const MEAL_IDS = MEALS.map((m) => m.id);
export const NUTRIENTS = ["kcal", "protein", "carbs", "fat", "fiber"];

/** The units a quantity can be logged in. Weight units convert exactly; the rest need a known measure. */
export const UNITS = {
  serving: { one: "serving", many: "servings" },
  g: { one: "g", many: "g", grams: 1 },
  oz: { one: "oz", many: "oz", grams: 28.349523125 },
  cup: { one: "cup", many: "cups" },
  tbsp: { one: "tbsp", many: "tbsp" },
  tsp: { one: "tsp", many: "tsp" },
  piece: { one: "piece", many: "pieces" },
  ml: { one: "ml", many: "ml", ml: 1 },
};
export const UNIT_IDS = Object.keys(UNITS);

/** Which meal a time of day most likely belongs to. */
export function mealForTime(date = new Date()) {
  const h = date.getHours();
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 17) return "snacks";
  if (h < 21) return "dinner";
  return "snacks";
}

/* ── quantities ────────────────────────────────────────────────────────── */

const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Grams for qty × unit of this food, when that can be known. */
export function gramsFor(food, qty, unit) {
  if (!food || !(qty >= 0)) return null;
  const u = UNITS[unit];
  if (!u) return null;
  if (u.grams) return qty * u.grams;
  const s = food.serving || {};
  if (unit === "serving") return s.grams ? qty * s.grams : null;
  const p = (food.portions || []).find((x) => x.unit === unit && x.grams > 0);
  if (p) return (qty * p.grams) / (p.amount || 1);
  if (s.unit === unit && s.grams > 0) return (qty * s.grams) / (s.amount || 1);
  return null;
}

/** How many servings qty × unit is, when that can be known. */
export function servingsFor(food, qty, unit) {
  if (!food || !(qty >= 0)) return null;
  if (unit === "serving") return qty;
  const s = food.serving || {};
  if (s.unit === unit && s.amount > 0) return qty / s.amount; // e.g. a serving *is* 2 pieces
  if (unit === "ml" && s.ml > 0) return qty / s.ml;
  const g = gramsFor(food, qty, unit);
  if (g != null && s.grams > 0) return g / s.grams;
  return null;
}

/**
 * Nutrients for qty × unit, or null when the unit can't be converted for
 * this food (a cup of something with no known cup weight, say). Unknown
 * nutrients stay null.
 */
export function nutrientsFor(food, qty, unit) {
  const k = servingsFor(food, qty, unit);
  if (k == null || !food?.nutrients) return null;
  const out = {};
  for (const n of NUTRIENTS) {
    const v = food.nutrients[n];
    out[n] = v == null ? null : round(v * k, n === "kcal" ? 0 : 1);
  }
  return out;
}

/** The units this food can honestly be logged in. */
export function unitsFor(food) {
  return UNIT_IDS.filter((u) => nutrientsFor(food, 1, u) != null);
}

export function fmtQty(qty, unit, serving) {
  const q = Number.isInteger(qty) ? String(qty) : String(round(qty, 2));
  if (unit === "serving" && serving?.label) return qty === 1 ? serving.label : `${q} × ${serving.label.replace(/^1\s+/, "")}`;
  // "1 large (50 g)" is a clearer piece than "1 piece": 3 of them read "3 × large (50 g)".
  if (unit === "piece" && serving?.unit === "piece" && serving.amount === 1 && serving.label) {
    return qty === 1 ? serving.label : `${q} × ${serving.label.replace(/^1\s+/, "")}`;
  }
  const u = UNITS[unit] || UNITS.serving;
  return `${q} ${qty === 1 ? u.one : u.many}`;
}

/* ── understanding what you typed ──────────────────────────────────────── */

const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, dozen: 12 };
const FRACTIONS = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75 };
const UNIT_WORDS = [
  [/^(g|gr|gram|grams)$/i, "g", 1],
  [/^(kg|kilo|kilos|kilogram|kilograms)$/i, "g", 1000],
  [/^(oz|ounce|ounces)$/i, "oz", 1],
  [/^(lb|lbs|pound|pounds)$/i, "oz", 16],
  [/^(cup|cups|c)$/i, "cup", 1],
  [/^(tbsp|tablespoon|tablespoons|tbs)$/i, "tbsp", 1],
  [/^(tsp|teaspoon|teaspoons)$/i, "tsp", 1],
  [/^(ml|milliliter|milliliters|millilitre|millilitres)$/i, "ml", 1],
  [/^(piece|pieces|pc|pcs|item|items|slice|slices|whole)$/i, "piece", 1],
  [/^(serving|servings|container|containers|scoop|scoops|bar|bars|can|cans|bottle|bottles|packet|packets|pack|packs|pouch|pouches)$/i, "serving", 1],
];

function readNumber(tokens) {
  // "1 1/2", "1.5", "3/4", "½", "1½", "two", "a", "half"
  const t = tokens[0];
  if (t == null) return null;
  let m;
  if ((m = t.match(/^(\d+)([½⅓⅔¼¾])$/))) return { value: Number(m[1]) + FRACTIONS[m[2]], used: 1 };
  if (FRACTIONS[t]) return { value: FRACTIONS[t], used: 1 };
  if (/^\d+(\.\d+)?$/.test(t)) {
    const whole = Number(t);
    const next = tokens[1];
    if (next && /^\d+\/\d+$/.test(next)) {
      const [a, b] = next.split("/").map(Number);
      if (b) return { value: whole + a / b, used: 2 };
    }
    return { value: whole, used: 1 };
  }
  if (/^\d+\/\d+$/.test(t)) {
    const [a, b] = t.split("/").map(Number);
    return b ? { value: a / b, used: 1 } : null;
  }
  const w = WORD_NUM[t.toLowerCase()];
  return w != null ? { value: w, used: 1 } : null;
}

/** "eggs" → "egg", "berries" → "berry"; leaves "hummus" and "glass" alone. */
export function singular(word) {
  if (/ies$/i.test(word) && word.length > 4) return word.replace(/ies$/i, "y");
  if (/(ss|us|is)$/i.test(word) || word.length <= 3) return word;
  if (/(ches|shes|xes|oes)$/i.test(word)) return word.replace(/es$/i, "");
  return word.replace(/s$/i, "");
}

/**
 * "6 oz chicken breast" → { qty: 6, unit: "oz", term: "chicken breast" }.
 * "2 eggs" → { qty: 2, unit: null, count: true, term: "egg" } — a bare count.
 * "Wawa turkey hoagie" → { qty: 1, unit: null, term: "Wawa turkey hoagie" }.
 */
export function parseQuery(text) {
  const raw = String(text || "").trim().replace(/\s+/g, " ");
  const tokens = raw.replace(/(\d)(g|oz|ml|kg|lb|lbs)\b/gi, "$1 $2").split(" ").filter(Boolean);
  let qty = 1, unit = null, count = false, i = 0;
  const num = readNumber(tokens);
  if (num) {
    qty = num.value;
    i = num.used;
    const uw = tokens[i] && UNIT_WORDS.find(([re]) => re.test(tokens[i]));
    if (uw) {
      unit = uw[1];
      qty *= uw[2];
      i += 1;
      if (/^of$/i.test(tokens[i] || "")) i += 1;
    } else {
      count = true;
    }
  }
  let rest = tokens.slice(i);
  if (count && rest.length) rest = [...rest.slice(0, -1), singular(rest[rest.length - 1])];
  const term = rest.join(" ").trim() || raw;
  return { raw, qty: round(qty, 3), unit, count, term };
}

/**
 * The entry a search result suggests for what you typed: the unit you
 * asked for when this food supports it, a bare count as pieces when it
 * has a piece measure, otherwise servings. Returns the suggestion and a
 * note when your unit couldn't be honoured.
 */
export function suggestEntry(food, parsed) {
  const units = unitsFor(food);
  let unit = "serving", qty = parsed?.qty ?? 1, note = null;
  if (parsed?.unit && units.includes(parsed.unit)) unit = parsed.unit;
  else if (parsed?.unit) note = `This food has no ${UNITS[parsed.unit].one} measure, so it's in servings — check the amount.`;
  else if (parsed?.count && units.includes("piece")) unit = "piece";
  if (unit === "serving" && parsed?.unit && !units.includes(parsed.unit)) qty = 1;
  return { qty, unit, units, nutrients: nutrientsFor(food, qty, unit), note };
}

/* ── the day ───────────────────────────────────────────────────────────── */

const has = (v) => v !== null && v !== undefined && v !== "";

/**
 * A day's food: entries grouped by meal with subtotals, the quick-add
 * totals typed without itemising (older days, or the log dialog), and the
 * grand total. `missing` counts entries that don't list a nutrient, so a
 * fiber total can say it's incomplete instead of pretending.
 */
export function dayFood(manual) {
  const entries = Array.isArray(manual?.foods) ? manual.foods : [];
  const zero = () => ({ kcal: null, protein: null, carbs: null, fat: null, fiber: null });
  const add = (tot, src) => {
    for (const n of NUTRIENTS) if (has(src[n])) tot[n] = (tot[n] ?? 0) + Number(src[n]);
  };
  const byMeal = Object.fromEntries(MEALS.map((m) => [m.id, { entries: [], totals: zero() }]));
  const missing = Object.fromEntries(NUTRIENTS.map((n) => [n, 0]));
  const totals = zero();
  for (const e of entries) {
    const m = byMeal[e.meal] || byMeal.snacks;
    m.entries.push(e);
    add(m.totals, e);
    add(totals, e);
    for (const n of NUTRIENTS) if (!has(e[n])) missing[n] += 1;
  }
  const quick = NUTRIENTS.some((n) => has(manual?.[n])) ? Object.fromEntries(NUTRIENTS.map((n) => [n, has(manual[n]) ? Number(manual[n]) : null])) : null;
  if (quick) add(totals, quick);
  for (const n of NUTRIENTS) if (totals[n] != null) totals[n] = round(totals[n], n === "kcal" ? 0 : 1);
  return { entries, byMeal, quick, totals, missing, itemized: entries.length > 0 };
}

/** "7g remaining", "7g above target" — never a negative remainder. */
export function remainingText(current, target, unit = "") {
  if (current == null) return "Nothing logged";
  const d = Math.round((target - current) * 10) / 10;
  const n = (v) => Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (d > 0) return `${n(d)}${unit} remaining`;
  if (d < 0) return `${n(d)}${unit} above target`;
  return "On target";
}

/* ── the week's calories ───────────────────────────────────────────────── */

const addDaysKey = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const mondayKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return addDaysKey(key, -((new Date(y, m - 1, d).getDay() + 6) % 7));
};

/**
 * The week (Monday → Sunday) against the weekly target, in neutral terms:
 * what's been eaten, what remains of the weekly target, and the average
 * that leaves for each remaining day.
 *
 * Honesty rules:
 *  - Pace compares complete food days only, against the daily target for
 *    those same days.
 *  - A past day that isn't fully logged can't be counted as eaten or not
 *    eaten; for the weekly remainder it's counted at the daily target (or
 *    what was logged, if higher) and named as such.
 *  - The per-day average is never shown as a reason to eat less: below the
 *    bottom of your daily range it's replaced by "no need to make up for
 *    it"; above maintenance it's flagged as likely missing logs.
 *
 * `status(key)` and `kcal(key)` come from the resolved days.
 */
export function weeklyBudget(days, g, today, { foodStatus }) {
  const daily = g.kcalTarget;
  const weekly = g.weeklyTarget || daily * 7;
  const maintenance = g.maintenance || null;
  const mon = mondayKey(today);
  const keys = Array.from({ length: 7 }, (_, i) => addDaysKey(mon, i));
  const rows = keys.map((key) => {
    const d = days[key];
    const status = foodStatus(d);
    const kcal = d?.kcal ?? null;
    return { key, kcal, status, isToday: key === today, future: key > today, past: key < today };
  });
  const past = rows.filter((r) => r.past);
  const complete = past.filter((r) => r.status === "complete");
  const assumed = past.filter((r) => r.status !== "complete").map((r) => ({ key: r.key, counted: Math.max(r.kcal ?? 0, daily), status: r.status }));
  const knownTotal = complete.reduce((s, r) => s + r.kcal, 0);
  const knownPace = daily * complete.length;
  const consumedBefore = knownTotal + assumed.reduce((s, a) => s + a.counted, 0);
  const todayRow = rows.find((r) => r.isToday);
  const todaySoFar = todayRow?.kcal ?? null;
  const daysLeft = rows.filter((r) => !r.past).length; // today and the rest of the week
  const targetRemaining = weekly - consumedBefore;
  const raw = daysLeft ? targetRemaining / daysLeft : null;
  let perDay = raw, perDayState = "ok";
  if (raw != null && raw < g.kcalLow) { perDay = null; perDayState = "above"; }
  else if (raw != null && maintenance && raw > maintenance) { perDay = null; perDayState = "high"; }
  return {
    weekly, daily, maintenance, rows,
    knownTotal, knownDays: complete.length, knownPace,
    difference: complete.length ? knownTotal - knownPace : null,
    average: complete.length ? knownTotal / complete.length : null,
    consumedBefore, assumed, todaySoFar, daysLeft,
    targetRemaining, perDay, perDayState,
    remainingAfterToday: todaySoFar != null ? targetRemaining - todaySoFar : null,
  };
}
