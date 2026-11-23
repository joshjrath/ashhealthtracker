// The forecast model: a slowing (not linear) loss, maintenance at the goal,
// muscle kept better with lifting and protein, honest ranges, the status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, project, leanFactor, onTrack, scenarioInputs } from "../js/forecast.js";

const base = { weightLb: 180, bodyFat: 20, tdee: 2500, intakeNow: 2000, intake: 2000, factor: 0.4, maintainAt: null, days: 365 };

test("the same intake gives a slowing loss — less than the 3,500 kcal rule predicts", () => {
  const s = simulate(base);
  const q1 = s.w[0] - s.w[91], q4 = s.w[273] - s.w[364];
  assert.ok(q1 > q4 * 1.3, `first quarter ${q1.toFixed(1)} lb vs last ${q4.toFixed(1)} lb`);
  const rule = 180 - (500 * 365) / 3500;
  assert.ok(s.w[365] > rule + 5, `model ${s.w[365].toFixed(1)} vs rule ${rule.toFixed(1)}`);
  assert.ok(s.e[365] < s.e[0] - 80, "expenditure falls as weight falls");
});

test("at energy balance, nothing moves", () => {
  const s = simulate({ ...base, intakeNow: 2500, intake: 2500 });
  assert.ok(Math.abs(s.w[365] - 180) < 0.05, String(s.w[365]));
});

test("switching to maintenance at the goal holds weight there instead of dieting forever", () => {
  const s = simulate({ ...base, maintainAt: 15, days: 900 });
  assert.ok(s.reachedAt > 0);
  const after = s.w.slice(s.reachedAt + 30);
  assert.ok(Math.max(...after) - Math.min(...after) < 0.3, "flat after the switch");
  assert.ok(Math.abs(s.bf.at(-1) - 15) < 0.4, String(s.bf.at(-1)));
});

test("lifting and protein keep more lean mass for the same intake", () => {
  const none = simulate({ ...base, factor: leanFactor(0, 1.0) });
  const lift = simulate({ ...base, factor: leanFactor(3, 2.0) });
  const lostLean = (s) => s.lean[0] - s.lean[182];
  assert.ok(lostLean(lift) < lostLean(none) * 0.6, `${lostLean(lift)} vs ${lostLean(none)}`);
  assert.ok(lift.bf[182] < none.bf[182], "and body fat falls further");
  assert.ok(leanFactor(3, 2) < leanFactor(2, 2) && leanFactor(2, 2) < leanFactor(2, 1.4));
});

test("ranges widen with time and contain the middle path", () => {
  const p = project({ ...base, tdeeSd: 120, bodyFatErr: 3, maintainAt: 12 }, { runs: 40, milestones: [15, 12] });
  for (const d of [30, 182, 365]) assert.ok(p.w.p10[d] <= p.w.p50[d] && p.w.p50[d] <= p.w.p90[d]);
  assert.ok(p.w.p90[365] - p.w.p10[365] > p.w.p90[30] - p.w.p10[30]);
  const m15 = p.milestones.find((m) => m.bf === 15), m12 = p.milestones.find((m) => m.bf === 12);
  assert.ok(m15.median < m12.median);
  assert.ok(m12.early <= m12.median && (m12.late == null || m12.median <= m12.late));
});

test("a what-if with fewer calories is faster; adding steps counts modestly", () => {
  const start = { weight: 180, bodyFat: 20, bodyFatErr: 3, tdee: 2500, tdeeSd: 100, intakeNow: 2000, sessions: 3, protein: 2, steps: 8000, target: 12 };
  const now = simulate(scenarioInputs(start, {}));
  const less = simulate(scenarioInputs(start, { kcal: 1800 }));
  const walk = scenarioInputs(start, { steps: 10000 });
  assert.ok(less.w[91] < now.w[91] - 1, `${less.w[91]} vs ${now.w[91]}`);
  assert.ok(less.reachedAt < now.reachedAt, "reaches the goal sooner");
  assert.ok(walk.activity > 50 && walk.activity < 110, String(walk.activity));
});

test("on-track status: pace against plan, with too-fast flagged", () => {
  const st = (ratePct, extra = {}) => onTrack({ ratePct, pace: 0.7, confidence: "established", phase: "cut", strength: "stable", bodyFat: 18, target: 10, ...extra }, null, "2026-11-23").id;
  assert.equal(st(-0.7), "on");
  assert.equal(st(-0.2), "slow");
  assert.equal(st(-1.05), "ahead");
  assert.equal(st(-1.3), "fast");
  assert.equal(st(-0.9, { strength: "declining" }), "fast");
  assert.equal(onTrack({ ratePct: null, confidence: "preliminary" }, null, "2026-11-23").id, "insufficient");
});
