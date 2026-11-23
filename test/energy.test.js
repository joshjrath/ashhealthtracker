// The adaptive TDEE engine, checked against known answers and the awkward cases:
// missing logs, a wild weigh-in, a jump in activity, no data, plateaus, safe suggestions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDay } from "../js/sources.js";
import { DEFAULT_GOALS, addDays } from "../js/metrics.js";
import { adaptiveTdee, kcalPerLb, leanShare, theilSen, plateau, calorieAdvice, weightTrend, intakeSummary, cutPace } from "../js/energy.js";

const TODAY = "2026-11-23";
const g0 = { ...DEFAULT_GOALS, maintenance: 2500, sex: "male", bodyFat: 18 };

/**
 * A synthetic person whose true burn is `tdee`, eating `intake`, losing exactly
 * what physics says (at the model's own energy density), with optional noise.
 */
function person({ weeks = 12, tdee = 2400, intake = 1900, start = 180, bf = 18, logEvery = 1, weighEvery = 1, noise = 0, extra = {} } = {}) {
  const raw = {};
  let w = start;
  const n = weeks * 7;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = n - 1; i >= 0; i--) {
    const k = addDays(TODAY, -i);
    const manual = {};
    if ((n - i) % logEvery === 0) Object.assign(manual, { kcal: intake, protein: 160, foodDone: true });
    if ((n - i) % weighEvery === 0) manual.weight = Math.round((w + noise * rnd() * 2) * 10) / 10;
    raw[k] = { manual: { ...manual, ...(extra[k] || {}) }, apple: extra.apple?.[k] || {} };
    w -= (tdee - intake) / kcalPerLb(w, bf);
  }
  return Object.fromEntries(Object.entries(raw).map(([k, d]) => [k, resolveDay(d, k)]));
}

test("tissue energetics follow the NIH model, not 3,500 kcal/lb", () => {
  assert.ok(Math.abs(leanShare(15) - 2.0 / 17.0) < 0.002);
  const at = (bf) => Math.round(kcalPerLb(165, bf));
  assert.deepEqual([at(15), at(20), at(30)], [2619, 2864, 3187]);
  assert.ok(at(45) < 3500, "even quite high body fat stays under the old rule");
});

test("a robust trend ignores a single wild weigh-in", () => {
  const pts = Array.from({ length: 21 }, (_, i) => [i, 180 - i * 0.1]);
  const clean = theilSen(pts).slope;
  pts[10] = [10, 186]; // a 5-lb water spike
  const spiked = theilSen(pts).slope;
  assert.ok(Math.abs(clean - -0.1) < 1e-9);
  assert.ok(Math.abs(spiked - clean) < 0.005, `slope moved by ${Math.abs(spiked - clean)}`);
});

test("it finds the true burn from intake and weight, starting from a wrong guess", () => {
  const days = person({ tdee: 2300, intake: 1800 });
  const e = adaptiveTdee(days, g0, TODAY); // starts at 2,500
  assert.ok(Math.abs(e.estimate - 2300) <= 60, `estimate ${e.estimate}`);
  assert.equal(e.confidence, "established");
  assert.ok(e.low < 2300 && e.high > 2300, "the range covers the truth");
});

test("missing food logs are left out, never zero — and only widen the range", () => {
  const full = adaptiveTdee(person({ tdee: 2300, intake: 1800 }), g0, TODAY);
  const sparse = adaptiveTdee(person({ tdee: 2300, intake: 1800, logEvery: 2 }), g0, TODAY);
  assert.ok(Math.abs(sparse.estimate - 2300) <= 80, `sparse estimate ${sparse.estimate}`);
  assert.ok(sparse.sd >= full.sd, "less data, less certainty");
  // a missing day read as zero would have dragged intake (and the estimate) far down
  assert.ok(sparse.estimate > 2000);
});

test("noisy daily weights (±1.5 lb water) still converge, and one odd weigh-in barely moves the estimate", () => {
  const noisy = adaptiveTdee(person({ tdee: 2300, intake: 1800, noise: 1.5 }), g0, TODAY);
  assert.ok(Math.abs(noisy.estimate - 2300) <= 120, `noisy estimate ${noisy.estimate}`);
  const base = person({ tdee: 2300, intake: 1800 });
  const before = adaptiveTdee(base, g0, TODAY).estimate;
  const spike = { ...base, [TODAY]: resolveDay({ manual: { weight: base[TODAY].weight + 5, kcal: 1800, foodDone: true } }, TODAY) };
  const after = adaptiveTdee(spike, g0, TODAY).estimate;
  assert.ok(Math.abs(after - before) <= 40, `a 5-lb spike moved it ${after - before} kcal`);
});

test("no data: preliminary, at your maintenance setting", () => {
  const e = adaptiveTdee({}, g0, TODAY);
  assert.equal(e.confidence, "preliminary");
  assert.equal(e.estimate, 2500);
  const two = adaptiveTdee(person({ weeks: 2 }), g0, TODAY);
  assert.notEqual(two.confidence, "established", "two weeks isn't established");
});

test("more activity nudges the estimate as a hint (discounted, half credit) — never adds the watch's calories", () => {
  const apple = {};
  for (let i = 0; i < 84; i++) apple[addDays(TODAY, -i)] = { activeKcal: i < 14 ? 900 : 500 }; // +400 kcal/day for the last two weeks
  const withAct = adaptiveTdee(person({ tdee: 2300, intake: 1800, extra: { apple } }), g0, TODAY);
  const without = adaptiveTdee(person({ tdee: 2300, intake: 1800 }), g0, TODAY);
  const moved = withAct.estimate - without.estimate;
  assert.ok(moved > 0 && moved < 0.75 * 400, `moved ${moved}; adding the watch outright would be +400`);
});

test("plateaus: weeks of flat weight are confirmed; a short stall is only possible; few weigh-ins are insufficient", () => {
  const flat = person({ tdee: 1900, intake: 1900 }); // truly at maintenance → flat
  const e = adaptiveTdee(flat, g0, TODAY);
  assert.equal(plateau(flat, g0, TODAY, e).status, "confirmed");
  const losing = person({ tdee: 2400, intake: 1800 });
  assert.equal(plateau(losing, g0, TODAY, adaptiveTdee(losing, g0, TODAY)).status, "progressing");
  const shortStall = { ...losing };
  const w = losing[addDays(TODAY, -12)].weight;
  for (let i = 0; i < 12; i++) shortStall[addDays(TODAY, -i)] = resolveDay({ manual: { weight: w, kcal: 1800, foodDone: true } }, addDays(TODAY, -i));
  assert.equal(plateau(shortStall, g0, TODAY, adaptiveTdee(shortStall, g0, TODAY)).status, "possible");
  const sparse = person({ weighEvery: 9 });
  assert.equal(plateau(sparse, g0, TODAY, adaptiveTdee(sparse, g0, TODAY)).status, "insufficient");
});

test("plateau factors are evidence, labelled possible — e.g. fewer complete logs, more carbs", () => {
  const days = person({ tdee: 1900, intake: 1900 });
  for (let i = 0; i < 14; i++) {
    const k = addDays(TODAY, -i);
    days[k] = resolveDay({ manual: { weight: days[k].weight, ...(i % 2 ? { kcal: 1900, carbs: 320, foodDone: true } : {}) } }, k);
  }
  for (let i = 14; i < 28; i++) { const k = addDays(TODAY, -i); days[k] = resolveDay({ manual: { weight: days[k].weight, kcal: 1900, carbs: 200, foodDone: true } }, k); }
  const p = plateau(days, g0, TODAY, adaptiveTdee(days, g0, TODAY));
  const ids = p.factors.map((f) => f.id);
  assert.ok(ids.includes("logging"), ids.join());
  assert.ok(ids.includes("carbs"), ids.join());
  assert.match(p.next, /logging/i, "fix the data before changing targets");
});

test("calorie suggestions: never below the floor, never a cut on a possible plateau, capped on a confirmed one", () => {
  const days = person({ tdee: 2300, intake: 1800 });
  const energy = adaptiveTdee(days, g0, TODAY);
  const w = weightTrend(days, TODAY, 28).now;
  const a = calorieAdvice({ days, g: { ...g0, kcalTarget: 2100, kcalLow: 2000, kcalHigh: 2200 }, today: TODAY, energy, plat: { status: "progressing" }, phase: "cut", weight: w });
  assert.ok(a.target < energy.estimate && a.target >= 1500, `target ${a.target}`);
  const possible = calorieAdvice({ days, g: { ...g0, kcalTarget: 2100 }, today: TODAY, energy, plat: { status: "possible" }, phase: "cut", weight: w });
  assert.ok(possible.target >= 2100, "a brief stall never lowers the target");
  const confirmed = calorieAdvice({ days, g: { ...g0, kcalTarget: 2100 }, today: TODAY, energy, plat: { status: "confirmed" }, phase: "cut", weight: w });
  assert.ok(confirmed.target >= 2100 - 150, "at most 150 kcal on a confirmed plateau");
  const tiny = calorieAdvice({ days, g: { ...g0, sex: "female", kcalTarget: 1300 }, today: TODAY, energy: { ...energy, estimate: 1400 }, plat: null, phase: "cut", weight: 110 });
  assert.ok(tiny.target >= tiny.floor && tiny.floor >= 1200, "safe floor");
  assert.equal(calorieAdvice({ days, g: g0, today: TODAY, energy: { ...energy, confidence: "preliminary" }, plat: null, phase: "cut", weight: w }).suggest, false, "no suggestion from a preliminary estimate");
  const bulk = calorieAdvice({ days, g: g0, today: TODAY, energy, plat: null, phase: "bulk", weight: w });
  assert.ok(bulk.target > energy.estimate && bulk.target <= energy.estimate + 300);
  assert.equal(calorieAdvice({ days, g: g0, today: TODAY, energy, plat: null, phase: "maintain", weight: w }).target, Math.round(energy.estimate / 25) * 25);
  assert.ok(cutPace(25) > cutPace(13), "slower when leaner");
});

test("intake averages only complete days, and says how many were partial", () => {
  const raw = {};
  for (let i = 0; i < 14; i++) raw[addDays(TODAY, -i)] = { manual: i < 8 ? { kcal: 2000, foodDone: true } : { kcal: 400 } };
  const days = Object.fromEntries(Object.entries(raw).map(([k, d]) => [k, resolveDay(d, k)]));
  const s = intakeSummary(days, TODAY);
  assert.equal(s.kcal, 2000);
  assert.equal(s.days, 8);
  assert.equal(s.partial, 6);
});
