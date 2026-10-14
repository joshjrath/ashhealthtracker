// The lift form: logging on any past day, and moving a session to the day it belongs to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liftTyped, liftDirty, liftWrites, liftForm } from "../js/strength.js";
import { resolveDay } from "../js/sources.js";

const bench = { id: "l_bench", exercise: "Bench press", sets: [{ reps: 8, weight: 135, unit: "lb" }] };
const squat = { id: "l_squat", exercise: "Squat", sets: [{ reps: 5, weight: 225, unit: "lb" }] };
const blank = () => ({ exercise: "", sets: [{ reps: "", weight: "", unit: "lb" }] });
const rawWith = (days) => Object.fromEntries(Object.entries(days).map(([k, lifts]) => [k, { manual: { lifts, kcal: 2000 }, apple: {} }]));
const ctxFor = (raw, today) => ({ raw, today, days: Object.fromEntries(Object.keys(raw).map((k) => [k, resolveDay(raw[k], k)])) });

test("an empty form isn't 'typed'; any exercise, reps or weight is", () => {
  assert.equal(liftTyped({ lifts: [blank()] }), false);
  assert.equal(liftTyped({ lifts: [] }), false);
  assert.equal(liftTyped({ lifts: [{ ...blank(), exercise: "Row" }] }), true);
  assert.equal(liftTyped({ lifts: [{ exercise: "", sets: [{ reps: "8", weight: "", unit: "lb" }] }] }), true);
});

test("dirty means the form differs from what's saved on the day it came from", () => {
  const raw = rawWith({ "2026-10-12": [bench] });
  assert.equal(liftDirty(raw, { from: "2026-10-12", lifts: [structuredClone(bench)] }), false, "opened, untouched");
  // what the form holds after typing: strings, not numbers
  assert.equal(liftDirty(raw, { from: "2026-10-12", lifts: [{ ...bench, sets: [{ reps: "8", weight: "135", unit: "lb" }] }] }), false);
  assert.equal(liftDirty(raw, { from: "2026-10-12", lifts: [{ ...bench, sets: [{ reps: "10", weight: "135", unit: "lb" }] }] }), true);
  assert.equal(liftDirty(raw, { from: "2026-10-13", lifts: [blank()] }), false, "blank form on an empty day");
  assert.equal(liftDirty(raw, { from: "2026-10-13", lifts: [{ ...blank(), exercise: "Row", sets: [{ reps: 5, weight: 0, unit: "lb" }] }] }), true);
});

test("saving on the day it was opened just replaces that day's lifts", () => {
  const raw = rawWith({ "2026-10-12": [bench] });
  assert.deepEqual(liftWrites(raw, { key: "2026-10-12", from: "2026-10-12" }, [squat]), [{ key: "2026-10-12", lifts: [squat] }]);
  assert.deepEqual(liftWrites(raw, { key: "2026-10-12", from: "2026-10-12" }, []), [{ key: "2026-10-12", lifts: [] }], "clearing");
});

test("typed after midnight, saved on yesterday: added to yesterday, today untouched", () => {
  const raw = rawWith({ "2026-10-12": [bench] });
  const w = liftWrites(raw, { key: "2026-10-12", from: "2026-10-13" }, [squat]);
  assert.deepEqual(w, [{ key: "2026-10-12", lifts: [bench, squat] }]);
});

test("a session saved on the wrong day moves: written to the new day first, then taken off the old one", () => {
  const raw = rawWith({ "2026-10-13": [squat], "2026-10-12": [bench] });
  const w = liftWrites(raw, { key: "2026-10-12", from: "2026-10-13" }, [squat]);
  assert.deepEqual(w, [{ key: "2026-10-12", lifts: [bench, squat] }, { key: "2026-10-13", lifts: [] }]);
  // onto a day with nothing yet
  assert.deepEqual(liftWrites(rawWith({ "2026-10-13": [squat] }), { key: "2026-09-01", from: "2026-10-13" }, [squat]),
    [{ key: "2026-09-01", lifts: [squat] }, { key: "2026-10-13", lifts: [] }]);
});

test("the form shows the day picker, and says what a move will do", () => {
  const raw = rawWith({ "2026-10-13": [squat], "2026-10-12": [bench] });
  const ctx = ctxFor(raw, "2026-10-13");
  const plain = liftForm(ctx, { key: "2026-10-13", from: "2026-10-13", lifts: [squat] });
  assert.match(plain, /type="date" name="day" value="2026-10-13" max="2026-10-13"/);
  assert.match(plain, /Today · Tue, Oct 13/);
  assert.match(plain, />Save lifts</);
  assert.match(plain, /Clear this day's lifts/);
  const moving = liftForm(ctx, { key: "2026-10-12", from: "2026-10-13", lifts: [squat] });
  assert.match(moving, /Yesterday · Mon, Oct 12/);
  assert.match(moving, /moves this session from <b>Tue, Oct 13<\/b> to <b>Mon, Oct 12<\/b>/);
  assert.match(moving, /already has <b>Bench press<\/b> logged/);
  assert.match(moving, />Move to Mon, Oct 12</);
  assert.doesNotMatch(moving, /Clear this day's lifts/, "clearing only applies to the day it was opened on");
});

test("just past midnight with nothing logged today, the form offers yesterday", () => {
  const ctx = ctxFor(rawWith({}), "2026-10-13");
  assert.match(liftForm(ctx, { key: "2026-10-13", from: "2026-10-13", lifts: [blank()], lateNight: true }), /last night's session\?[\s\S]*Put it on Mon, Oct 12/);
  assert.doesNotMatch(liftForm(ctx, { key: "2026-10-13", from: "2026-10-13", lifts: [blank()], lateNight: false }), /last night/);
});

/* ── repeating a session ───────────────────────────────────────────────── */
import { pastSessions, lastTime, copyLifts } from "../js/training.js";
import { lastTimeHtml } from "../js/strength.js";

test("past sessions are newest first and leave out the day being logged", () => {
  const days = ctxFor(rawWith({ "2026-10-08": [bench], "2026-10-10": [squat], "2026-10-12": [bench, squat], "2026-10-11": [] }), "2026-10-13").days;
  assert.deepEqual(pastSessions(days, "2026-10-12").map((p) => p.key), ["2026-10-10", "2026-10-08"]);
  assert.deepEqual(pastSessions(days, "2026-10-13", 2).map((p) => p.key), ["2026-10-12", "2026-10-10"]);
});

test("a copied session is editable rows with the same sets and no ids — changing it never touches the original", () => {
  const rows = copyLifts([bench, squat]);
  assert.deepEqual(rows, [{ exercise: "Bench press", sets: [{ reps: 8, weight: 135, unit: "lb" }] }, { exercise: "Squat", sets: [{ reps: 5, weight: 225, unit: "lb" }] }]);
  rows[0].sets[0].reps = 10;
  rows[0].sets.push({ reps: 6, weight: 145, unit: "lb" });
  assert.equal(bench.sets[0].reps, 8);
  assert.equal(bench.sets.length, 1);
});

test("last time finds the latest other day with that exercise, by name in any case", () => {
  const heavier = { ...bench, sets: [{ reps: 5, weight: 155, unit: "lb" }] };
  const days = ctxFor(rawWith({ "2026-10-06": [bench], "2026-10-09": [heavier], "2026-10-12": [squat] }), "2026-10-13").days;
  assert.deepEqual(lastTime(days, "  bench PRESS ", "2026-10-13"), { key: "2026-10-09", sets: heavier.sets });
  assert.deepEqual(lastTime(days, "Bench press", "2026-10-09").key, "2026-10-06", "never the day being logged");
  assert.equal(lastTime(days, "Deadlift", "2026-10-13"), null);
  const draft = { key: "2026-10-13", lifts: [{ exercise: "Bench press", sets: [{ reps: "", weight: "", unit: "lb" }] }] };
  assert.match(lastTimeHtml(days, draft, 0), /Last time, Fri, Oct 9: <b>5 @ 155 lb<\/b>.*Use these sets/);
  draft.lifts[0].sets = [{ reps: "5", weight: "155", unit: "lb" }];
  assert.doesNotMatch(lastTimeHtml(days, draft, 0), /Use these sets/, "nothing to use when it's the same");
});

test("the form offers past sessions to repeat, open while the form is empty", () => {
  const ctx = ctxFor(rawWith({ "2026-10-12": [bench, squat] }), "2026-10-13");
  const empty = liftForm(ctx, { key: "2026-10-13", from: "2026-10-13", lifts: [blank()] });
  assert.match(empty, /<details class="lrepeat" open>/);
  assert.match(empty, /data-act="lift-repeat" data-key="2026-10-12"[\s\S]*Bench press · Squat/);
  const copied = liftForm(ctx, { key: "2026-10-13", from: "2026-10-13", lifts: copyLifts([bench]), copiedFrom: "2026-10-12" });
  assert.match(copied, /<details class="lrepeat">/, "closed once there's something in the form");
  assert.match(copied, /Copied from <b>Mon, Oct 12<\/b>/);
});
