/* ──────────────────────────────────────────────────────────────────────────
   Your log as readable tables, for the Google Sheet backup.

   The sheet gets two things each night: these tables (one tab each, so
   the data can be read, sorted and searched without the site) and the
   full backup (kept in hidden tabs, so Ash Health → Restore can put
   everything back exactly). The numbers here are worked out by the same
   code the site uses, so the sheet and the site always agree.

   Every table is a list of rows, the first row its headers, every row the
   same length. Cells are text, numbers, or "" for nothing.
   ────────────────────────────────────────────────────────────────────────── */
import { resolveDay } from "../js/sources.js";
import { DEFAULT_GOALS, GOAL_IDS, METRICS, sleepMinutes, foodStatus, dayScore } from "../js/metrics.js";
import { MEALS, fmtQty } from "../js/nutrition.js";
import { mealTotals } from "../js/library.js";
import { DEFAULT_SUPPLEMENTS, dueOn, taken, suppLabel, periodsOf, isTaking } from "../js/supplements.js";
import { MUSCLES } from "../js/liftstats.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SOURCE = { verified: "Verified", database: "Database", estimate: "Estimated (AI)", custom: "Custom", placeholder: "Placeholder" };
const PLAN = { push: "Push", pull: "Pull", legs: "Legs", strength: "Strength", cardio: "Cardio", any: "Any workout", rest: "Rest" };

/** A cell: numbers stay numbers; text that a spreadsheet would read as a formula is kept as text. */
function cell(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return Number.isFinite(v) ? v : "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}
const table = (head, rows) => [head, ...rows.map((r) => r.map(cell))];
const r1 = (v) => (v == null ? "" : Math.round(v * 10) / 10);
const weekday = (k) => { const [y, m, d] = k.split("-").map(Number); return WD[new Date(y, m - 1, d).getDay()]; };
const setsText = (sets) => sets.map((s) => `${s.reps}${s.weight ? `×${s.weight}${s.unit}` : ""}`).join(", ");

/** doc: an export (toExport) → { tab name: rows }. */
export function sheetTables(doc) {
  const g = { ...DEFAULT_GOALS, ...(doc.goals || {}), plan: doc.plan || null };
  const supps = g.supplements || DEFAULT_SUPPLEMENTS;
  const keys = Object.keys(doc.days || {}).sort().reverse(); // newest first
  const days = Object.fromEntries(keys.map((k) => [k, resolveDay(doc.days[k], k)]));

  const dayRows = keys.map((k) => {
    const d = days[k];
    const s = dayScore(d, g);
    const due = dueOn(supps, k);
    const took = supps.filter((x) => taken(d, x.id) === true).map((x) => x.name);
    const skipped = due.filter((x) => taken(d, x.id) === false).map((x) => x.name);
    const mins = sleepMinutes(d);
    const fs = foodStatus(d);
    return [
      k, weekday(k), s.total ? `${s.hit} of ${s.total}` : "",
      d.kcal, r1(d.protein), r1(d.carbs), r1(d.fat), r1(d.fiber),
      fs === "complete" ? "Complete" : fs === "partial" ? "Partial" : "", d.foods?.length || "",
      d.weight, d.steps, d.activeKcal, d.exerciseMin,
      d.bed, d.wake, mins == null ? "" : Math.round(mins / 6) / 10,
      d.workout === true ? "Yes" : d.workout === false ? "No" : "",
      (d.workouts || []).map((w) => w.type).join(", "),
      (d.lifts || []).map((l) => l.exercise).join(", "),
      took.join(", "), skipped.join(", "),
    ];
  });

  const foodRows = [];
  for (const k of keys) {
    const entries = [...(days[k].foods || [])].sort((a, b) => MEALS.findIndex((m) => m.id === a.meal) - MEALS.findIndex((m) => m.id === b.meal) || String(a.time || "").localeCompare(String(b.time || "")));
    for (const e of entries) {
      foodRows.push([k, MEALS.find((m) => m.id === e.meal)?.label || e.meal, e.time, e.name, e.brand, fmtQty(e.qty, e.unit, e.serving),
        e.kcal, e.protein, e.carbs, e.fat, e.fiber, SOURCE[e.source?.kind] || "Custom", e.group?.name, e.notes]);
    }
    const q = doc.days[k]?.manual;
    if (q && ["kcal", "protein", "carbs", "fat", "fiber"].some((n) => q[n] != null)) {
      foodRows.push([k, "Quick add", "", "Totals typed in", "", "", q.kcal, q.protein, q.carbs, q.fat, q.fiber, "Custom", "", ""]);
    }
  }

  const liftRows = [];
  for (const k of keys) for (const l of days[k].lifts || []) l.sets.forEach((s, i) => liftRows.push([k, l.exercise, i + 1, s.reps, s.weight, s.unit, l.notes]));

  const workoutRows = [];
  for (const k of keys) for (const w of days[k].workouts || []) {
    workoutRows.push([k, w.type, w.start?.slice(11, 16), w.end?.slice(11, 16), r1(w.durationMin), r1(w.kcal), w.distance != null ? `${r1(w.distance)} ${w.distanceUnit || ""}`.trim() : "", r1(w.avgHR), r1(w.maxHR)]);
  }

  const lib = doc.library || {};
  const foods = [...(lib.foods || [])].sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || String(a.name).localeCompare(String(b.name)));
  const foodLib = foods.map((f) => [f.name, f.brand, f.serving?.label, f.nutrients?.kcal, f.nutrients?.protein, f.nutrients?.carbs, f.nutrients?.fat, f.nutrients?.fiber,
    SOURCE[f.source?.kind] || "Custom", !!f.favorite, f.uses?.count || 0, !!f.archived]);
  const meals = (lib.meals || []).map((m) => {
    const t = mealTotals(m).totals;
    return [m.name, (m.items || []).map((it) => `${it.name} (${fmtQty(it.qty, it.unit, it.serving)})`).join("; "), t.kcal, t.protein, t.carbs, t.fat, !!m.favorite, !!m.archived];
  });

  const settings = [
    ["Goals", "", ""],
    ...Object.keys(DEFAULT_GOALS).filter((k) => !["tracked", "supplements", "exerciseGroups"].includes(k)).map((k) => ["", k, g[k]]),
    ["", "Counted in the daily score", (g.tracked || []).filter((id) => GOAL_IDS.includes(id)).map((id) => METRICS[id].label).join(", ")],
    ["Supplements", "", ""],
    ...supps.map((s) => ["", suppLabel(s), `${isTaking(s) ? "Taking" : "Paused"} · ${periodsOf(s).map((p) => `${p.from || "from the start"} → ${p.to || "now"}`).join(", ") || "never started"}`]),
    ...(Object.keys(g.exerciseGroups || {}).length ? [["Muscle groups you set", "", ""], ...Object.entries(g.exerciseGroups).map(([ex, m]) => ["", ex, m === "none" ? "Not counted" : MUSCLES[m]?.label || m])] : []),
    ["Training plan", "", ""],
    ...(doc.plan ? Object.entries(doc.plan.days || {}).map(([d, t]) => ["", d, PLAN[t] || t]) : [["", "No plan set", ""]]),
    ["Rewards", "", ""],
    ...(lib.rewards || []).map((r) => ["", r.name, r.claimedAt ? `claimed ${String(r.claimedAt).slice(0, 10)}` : ""]),
  ];

  return {
    Days: table(["Date", "Day", "Goals hit", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Fiber (g)", "Food log", "Diary entries",
      "Weight (lb)", "Steps", "Active kcal", "Exercise (min)", "Bedtime", "Woke", "Sleep (h)", "Worked out", "Apple workouts", "Lifts", "Supplements taken", "Supplements skipped"], dayRows),
    "Food diary": table(["Date", "Meal", "Time", "Food", "Brand", "Amount", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Fiber (g)", "Numbers from", "From meal", "Notes"], foodRows),
    Lifts: table(["Date", "Exercise", "Set", "Reps", "Weight", "Unit", "Notes"], liftRows),
    Workouts: table(["Date", "Type", "Start", "End", "Minutes", "Calories", "Distance", "Avg HR", "Max HR"], workoutRows),
    "My foods": table(["Food", "Brand", "Serving", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Fiber (g)", "Numbers from", "Favorite", "Times logged", "Archived"], foodLib),
    Meals: table(["Meal", "Items", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Favorite", "Archived"], meals),
    Settings: table(["Section", "Item", "Value"], settings),
  };
}
