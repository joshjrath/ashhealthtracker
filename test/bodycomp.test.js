// Body composition: carrying a reading to a new weight without assuming
// every pound is fat, combining methods honestly, tape noise, and timelines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDay } from "../js/sources.js";
import { DEFAULT_GOALS, addDays } from "../js/metrics.js";
import { forbesLeanShare, carryBodyFat, currentBodyFat, bodyFatReadings, measureChange, measureSeries, waistToHeight, weeksToBodyFat, bodyFatTimelines, recompInsights, bodyMilestones, composition } from "../js/bodycomp.js";

const TODAY = "2026-11-23";
const g = { ...DEFAULT_GOALS, sex: "male", heightIn: 70, birthYear: 1995 };
const daysOf = (raw) => Object.fromEntries(Object.entries(raw).map(([k, m]) => [k, resolveDay({ manual: m }, k)]));

test("a loss isn't all fat: Forbes' lean share, and carrying a reading to a lower weight", () => {
  assert.equal(forbesLeanShare(10.4), 0.5);
  const forbes = carryBodyFat(20, 180, 170);
  const half = carryBodyFat(20, 180, 170, (f) => 0.5 * forbesLeanShare(f));
  const fatOnly = ((180 * 0.2 - 10) / 170) * 100;
  assert.ok(forbes > half && half > fatOnly, `${forbes} > ${half} > ${fatOnly}`);
  assert.ok(Math.abs(forbes - 17.7) < 0.1, String(forbes));
  assert.equal(carryBodyFat(20, 180, 180), 20);
});

test("one fresh DEXA reading is taken as measured, with DEXA's error", () => {
  const days = daysOf({ [TODAY]: { weight: 180, bodyFat: 18, bodyFatMethod: "dexa" } });
  const bf = currentBodyFat(days, g, TODAY, 180);
  assert.equal(bf.pct, 18);
  assert.equal(bf.kind, "measured");
  assert.ok(bf.err >= 1.8 && bf.err <= 2.1, String(bf.err));
  assert.equal(bf.reliable, true);
  const c = composition(180, bf);
  assert.equal(Math.round(c.fat * 10) / 10, 32.4);
  assert.ok(c.fatRange[0] < c.fat && c.fat < c.fatRange[1]);
});

test("methods that disagree widen the range instead of averaging it away", () => {
  const raw = { [TODAY]: { weight: 180, bodyFat: 14, bodyFatMethod: "dexa" }, [addDays(TODAY, -1)]: { weight: 180, bodyFat: 22, bodyFatMethod: "scale" } };
  const bf = currentBodyFat(daysOf(raw), g, TODAY, 180);
  assert.ok(bf.pct > 14 && bf.pct < 18, String(bf.pct));
  assert.ok(bf.err > 2.2, `err ${bf.err} should exceed DEXA's alone`);
});

test("waist and neck give a Navy estimate once sex and height are known — never without them", () => {
  const raw = { [TODAY]: { meas: { waist: 34, neck: 15.5 } } };
  const r = bodyFatReadings(daysOf(raw), g, TODAY);
  assert.equal(r.length, 1);
  assert.equal(r[0].method, "navy");
  assert.equal(r[0].kind, "estimate");
  assert.equal(bodyFatReadings(daysOf(raw), { ...g, heightIn: 0 }, TODAY).length, 0);
  // a Navy result you typed yourself that day isn't counted twice
  const both = { [TODAY]: { meas: { waist: 34, neck: 15.5 }, bodyFat: 17, bodyFatMethod: "navy" } };
  assert.equal(bodyFatReadings(daysOf(both), g, TODAY).length, 1);
});

test("a BMI guess is shown but never forecast from", () => {
  const days = daysOf({ [TODAY]: { weight: 180 } });
  const bf = currentBodyFat(days, g, TODAY, 180);
  assert.equal(bf.basis, "bmi");
  assert.equal(bf.reliable, false);
  const tl = bodyFatTimelines(bf, { enough: true, now: 180, pctPerWeek: -0.5, lowPerWeek: -1.2, highPerWeek: -0.6 }, [15, 12, 10]);
  assert.equal(tl.ok, false);
  assert.match(tl.why, /too rough/);
});

test("tape changes inside measurement noise aren't called progress", () => {
  const raw = {};
  for (let i = 0; i < 6; i++) raw[addDays(TODAY, -i * 7)] = { meas: { waist: 34 + (i % 2 ? 0.2 : 0) } };
  const days = daysOf(raw);
  const c = measureChange(measureSeries(days, "waist", TODAY), "waist", TODAY);
  assert.equal(c.change4Real, false);
  assert.equal(c.totalReal, false);
  const raw2 = {};
  for (let i = 0; i < 6; i++) raw2[addDays(TODAY, -i * 7)] = { meas: { waist: 33 + i * 0.3 } };
  const c2 = measureChange(measureSeries(daysOf(raw2), "waist", TODAY), "waist", TODAY);
  assert.ok(c2.change4 < -1 && c2.change4Real, String(c2.change4));
  assert.ok(Math.abs(c2.total - -1.5) < 1e-9);
});

test("waist-to-height uses the NICE bands", () => {
  assert.equal(waistToHeight(33, 70).band.id, "ok");
  assert.equal(waistToHeight(36, 70).band.id, "mid");
  assert.equal(waistToHeight(43, 70).band.id, "high");
  assert.equal(waistToHeight(33, 0), null);
});

test("timelines: leaner targets take longer; no timeline when not losing", () => {
  const a = weeksToBodyFat({ pct: 18, weight: 170, ratePct: -0.5, target: 15 });
  const b = weeksToBodyFat({ pct: 18, weight: 170, ratePct: -0.5, target: 12 });
  assert.ok(a.weeks > 0 && b.weeks > a.weeks);
  assert.ok(b.weight < a.weight);
  assert.equal(weeksToBodyFat({ pct: 18, weight: 170, ratePct: 0.1, target: 15 }), null);
  assert.equal(weeksToBodyFat({ pct: 14, weight: 170, ratePct: -0.5, target: 15 }).weeks, 0);
  const bf = { pct: 18, low: 15.5, high: 20.5, err: 2.5, reliable: true };
  const tl = bodyFatTimelines(bf, { enough: true, now: 170, pctPerWeek: -0.5, lowPerWeek: -1.2, highPerWeek: -0.5 }, [15, 12, 10]);
  assert.ok(tl.ok);
  for (const r of tl.rows) assert.ok(r.early <= r.weeks && r.weeks <= r.late, JSON.stringify(r));
  assert.equal(bodyFatTimelines(bf, { enough: true, now: 170, pctPerWeek: 0.02 }, [15]).ok, false);
});

test("waist down at a steady weight reads as possible recomposition; scale down with the waist unchanged doesn't claim fat loss", () => {
  const raw = {};
  for (let i = 0; i <= 42; i++) raw[addDays(TODAY, -i)] = { weight: 175 + (i % 3 === 0 ? 0.4 : -0.3) };
  for (let i = 0; i < 6; i++) raw[addDays(TODAY, -i * 7)].meas = { waist: 33 + i * 0.25 };
  let days = daysOf(raw);
  const waist = measureChange(measureSeries(days, "waist", TODAY), "waist", TODAY);
  const n = recompInsights({ days, today: TODAY, waist, strengthStatus: "stable" });
  assert.equal(n[0].kind, "good");
  assert.match(n[0].text, /recomposition/);
  const raw2 = {};
  for (let i = 0; i <= 42; i++) raw2[addDays(TODAY, -i)] = { weight: 170 + i * 0.1 };
  for (let i = 0; i < 6; i++) raw2[addDays(TODAY, -i * 7)].meas = { waist: 33 };
  days = daysOf(raw2);
  const w2 = measureChange(measureSeries(days, "waist", TODAY), "waist", TODAY);
  const n2 = recompInsights({ days, today: TODAY, waist: w2, strengthStatus: "declining" });
  assert.equal(n2[0].kind, "watch");
  assert.match(n2[0].text, /water and glycogen/);
});

test("milestones: whole inches off the waist, and body-fat steps crossed by a clear margin", () => {
  const raw = {};
  for (let i = 0; i < 8; i++) raw[addDays(TODAY, -i * 7)] = { meas: { waist: 32 + i * 0.4 } };
  raw[addDays(TODAY, -49)].bodyFat = 19; raw[addDays(TODAY, -49)].bodyFatMethod = "dexa";
  raw[TODAY].bodyFat = 14.8; raw[TODAY].bodyFatMethod = "dexa";
  const m = bodyMilestones(daysOf(raw), { ...g, heightIn: 0 }, TODAY);
  assert.deepEqual(m.filter((x) => x.kind === "waist").map((x) => x.inches).sort(), [1, 2]);
  assert.deepEqual(m.filter((x) => x.kind === "bf").map((x) => x.step).sort((a, b) => a - b), [15, 18]);
});
