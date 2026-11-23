// Readiness: judged against your own baseline, never from one reading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDay } from "../js/sources.js";
import { DEFAULT_GOALS, addDays } from "../js/metrics.js";
import { readiness, readinessAdvice, loadRatio } from "../js/readiness.js";

const TODAY = "2026-11-23";
const g = { ...DEFAULT_GOALS, sleepHours: 8 };
/** 35 days: normal sleep 8h, RHR ~55 (±1), HRV ~60 (±4), a lifting session every other day. */
function base(overrides = {}) {
  const days = {};
  for (let i = 34; i >= 0; i--) {
    const k = addDays(TODAY, -i);
    const o = overrides[i] || {};
    const manual = { bed: o.bed ?? "23:00", wake: o.wake ?? "07:00" };
    if (i % 2 === 0 && !o.noLift) manual.lifts = [{ id: `${k}`, exercise: "Bench press", sets: Array.from({ length: o.sets ?? 12 }, () => ({ reps: 8, weight: 135, unit: "lb" })) }];
    if (o.checkin) manual.checkin = o.checkin;
    const apple = { restingHR: o.rhr ?? 55 + ((i * 7) % 3) - 1, hrv: o.hrv ?? 60 + ((i * 5) % 9) - 4 };
    days[k] = resolveDay({ manual, apple }, k);
  }
  return days;
}

test("a normal stretch reads as well recovered", () => {
  const r = readiness({ days: base(), g, today: TODAY });
  assert.equal(r.status, "good");
  assert.ok(r.inputs >= 3);
});

test("one high resting-HR morning is noted but never flips the status", () => {
  const r = readiness({ days: base({ 0: { rhr: 66 } }), g, today: TODAY });
  const s = r.signals.find((x) => x.id === "rhr");
  assert.equal(s.level, "mild");
  assert.match(s.text, /one reading/);
  assert.notEqual(r.status, "recover");
});

test("sustained signals — RHR up for days and short sleep — recommend recovery", () => {
  const o = {};
  for (let i = 0; i < 3; i++) o[i] = { rhr: 63, bed: "01:30", wake: "06:30" };
  const r = readiness({ days: base(o), g, today: TODAY });
  assert.equal(r.status, "recover", JSON.stringify(r.signals));
  const advice = readinessAdvice(r);
  assert.ok(advice.some((a) => /volume|easy|rest/i.test(a.text)));
});

test("HRV is judged on a 7-day average", () => {
  const one = readiness({ days: base({ 0: { hrv: 30 } }), g, today: TODAY });
  assert.notEqual(one.signals.find((x) => x.id === "hrv").level, "strong");
  const o = {};
  for (let i = 0; i < 7; i++) o[i] = { hrv: 42 };
  const week = readiness({ days: base(o), g, today: TODAY });
  assert.equal(week.signals.find((x) => x.id === "hrv").level, "strong");
});

test("a training spike is flagged against the weeks before", () => {
  const o = {};
  for (let i = 0; i < 7; i++) o[i] = { sets: 30 };
  const days = base(o);
  assert.ok(loadRatio(days, TODAY).ratio > 1.5);
  assert.equal(readiness({ days, g, today: TODAY }).signals.find((x) => x.id === "load").level, "strong");
});

test("no data → not enough data, and the advice says what to log", () => {
  const r = readiness({ days: {}, g, today: TODAY });
  assert.equal(r.status, "insufficient");
  assert.match(readinessAdvice(r)[0].text, /check-in/);
});

test("check-ins count, but one rough morning alone isn't a strong signal", () => {
  const one = readiness({ days: base({ 0: { checkin: { fatigue: 5, energy: 1 } } }), g, today: TODAY });
  assert.equal(one.signals.find((x) => x.id === "feel").level, "mild");
  const three = readiness({ days: base({ 0: { checkin: { fatigue: 5, energy: 1 } }, 1: { checkin: { fatigue: 4, energy: 2 } }, 2: { checkin: { fatigue: 4, energy: 2 } } }), g, today: TODAY });
  assert.equal(three.signals.find((x) => x.id === "feel").level, "strong");
});

test("a planned rest day is advised as rest", () => {
  const plan = { days: { mon: "rest", tue: "push", wed: "pull", thu: "legs", fri: "push", sat: "pull", sun: "legs" }, since: null };
  const r = readiness({ days: base(), g: { ...g, plan }, today: TODAY }); // TODAY is a Monday
  assert.match(readinessAdvice(r)[0].text, /rest day/i);
});
