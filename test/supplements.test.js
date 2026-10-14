// Supplements: a list you keep, checked off one by one each day.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { resolveDay, cleanManual } from "../js/sources.js";
import { goalStatus, dayScore, DEFAULT_GOALS } from "../js/metrics.js";
import { cleanSupplements, suppStatus, suppCount, shownOn, applyCheckoff, checkoff, suppId, DEFAULT_SUPPLEMENTS } from "../js/supplements.js";

const LIST = [
  { id: "creatine", name: "Creatine", dose: "5 g" },
  { id: "fish_oil", name: "Fish oil", dose: "2 capsules", since: "2026-10-10" },
  { id: "beetroot", name: "Beetroot", since: "2026-10-10" },
];
const day = (key, manual) => resolveDay({ manual, apple: {} }, key);

test("the default list is creatine alone, so nothing changes until you add more", () => {
  assert.deepEqual(DEFAULT_GOALS.supplements, DEFAULT_SUPPLEMENTS);
  const g = { ...DEFAULT_GOALS };
  assert.equal(goalStatus("creatine", day("2026-10-01", { creatine: true }), g), "hit");
  assert.equal(goalStatus("creatine", day("2026-10-01", { creatine: false }), g), "miss");
  assert.equal(goalStatus("creatine", day("2026-10-01", { kcal: 100 }), g), "none");
  assert.equal(goalStatus("creatine", day("2026-10-01", {}), g, true), "pending");
});

test("each supplement is checked off on its own; the goal is hit when all that are due are taken", () => {
  assert.equal(suppStatus(day("2026-10-12", { creatine: true, supps: { fish_oil: true, beetroot: true } }), LIST), "hit");
  assert.equal(suppStatus(day("2026-10-12", { creatine: true, supps: { fish_oil: true } }), LIST, true), "pending", "still going today");
  assert.equal(suppStatus(day("2026-10-12", { creatine: true, supps: { fish_oil: true } }), LIST, false), "miss", "a past day missing one");
  assert.equal(suppStatus(day("2026-10-12", { creatine: true, supps: { beetroot: false } }), LIST, true), "miss", "marked skipped");
  assert.deepEqual(suppCount(day("2026-10-12", { supps: { fish_oil: true } }), LIST).left.map((s) => s.name), ["Creatine", "Beetroot"]);
});

test("adding a supplement never turns earlier days into misses; removing one stops it counting from then", () => {
  // Oct 5: before fish oil and beetroot were added — creatine alone decides
  assert.equal(suppStatus(day("2026-10-05", { creatine: true }), LIST), "hit");
  const removed = LIST.map((s) => (s.id === "beetroot" ? { ...s, until: "2026-10-13" } : s));
  assert.equal(suppStatus(day("2026-10-13", { creatine: true, supps: { fish_oil: true } }), removed), "hit");
  assert.equal(suppStatus(day("2026-10-12", { creatine: true, supps: { fish_oil: true } }), removed), "miss", "still due the day before");
  assert.equal(suppStatus(day("2026-10-12", {}), []), "off", "an empty list leaves the goal out");
  assert.equal(dayScore(day("2026-10-12", { creatine: true }), { ...DEFAULT_GOALS, tracked: ["creatine"], supplements: [] }).total, 0);
});

test("the log shows what's due that day plus anything already checked off for it", () => {
  const removed = [...LIST, { id: "zinc", name: "Zinc", since: "2026-09-01", until: "2026-09-20" }];
  assert.deepEqual(shownOn(removed, {}, "2026-10-05").map((s) => s.id), ["creatine"]);
  assert.deepEqual(shownOn(removed, { supps: { zinc: true } }, "2026-10-05").map((s) => s.id), ["creatine", "zinc"]);
  assert.deepEqual(shownOn(removed, {}, "2026-09-10").map((s) => s.id), ["creatine", "zinc"]);
});

test("the list and day checkoffs are cleaned; creatine keeps its own field", () => {
  assert.deepEqual(cleanSupplements([{ id: "fish_oil", name: " Fish oil ", dose: "" }, { id: "fish_oil", name: "dupe" }, { id: "Bad Id", name: "x" }, { id: "x", name: "" }, { id: "b", name: "B", since: "nope", until: "2026-10-01" }]),
    [{ id: "fish_oil", name: "Fish oil" }, { id: "b", name: "B", until: "2026-10-01" }]);
  assert.deepEqual(cleanSupplements(undefined), DEFAULT_SUPPLEMENTS);
  assert.deepEqual(cleanSupplements([]), [], "an empty list is allowed");
  assert.deepEqual(cleanManual({ creatine: true, supps: { fish_oil: true, beetroot: "yes", creatine: false, "BAD": true } }), { creatine: true, supps: { fish_oil: true } });
  assert.deepEqual(checkoff("creatine", true), { creatine: true });
  assert.deepEqual(checkoff("fish_oil", null), { supps: { fish_oil: null } });
  assert.deepEqual(applyCheckoff({ kcal: 5, supps: { fish_oil: true } }, "fish_oil", null), { kcal: 5 });
  assert.equal(suppId("Fish oil (Nordic)", [{ id: "fish_oil_nordic" }]), "fish_oil_nordic_2");
});

/* ── over HTTP ─────────────────────────────────────────────────────────── */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, server, base;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ash-supps-"));
  const store = await openStore({ file: join(dir, "data.json") });
  server = await createApp({ store, root, password: "", secret: "s".repeat(32), requireAuth: false, backupSchedule: false });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("the list is saved with your goals", async () => {
  const before = (await call("GET", "/api/state")).body.goals;
  assert.deepEqual(before.supplements, DEFAULT_SUPPLEMENTS);
  const r = await call("PUT", "/api/goals", { ...before, supplements: LIST });
  assert.deepEqual(r.body.goals.supplements, LIST);
  assert.deepEqual((await call("GET", "/api/state")).body.goals.supplements, LIST);
  // goals saved without the field (a tab open from before the update) keep the saved list
  assert.deepEqual((await call("PUT", "/api/goals", { protein: 150 })).body.goals.supplements, LIST);
  // so does importing an export made before there was a list
  await call("POST", "/api/import", { days: {}, goals: { protein: 140 } });
  assert.deepEqual((await call("GET", "/api/state")).body.goals.supplements, LIST);
});

test("checkoffs sent one at a time all stick, even sent together", async () => {
  await call("PATCH", "/api/days/2026-10-12", { kcal: 1800 });
  await Promise.all([
    call("PATCH", "/api/days/2026-10-12", checkoff("creatine", true)),
    call("PATCH", "/api/days/2026-10-12", checkoff("fish_oil", true)),
    call("PATCH", "/api/days/2026-10-12", checkoff("beetroot", true)),
  ]);
  let m = (await call("GET", "/api/state")).body.days["2026-10-12"].manual;
  assert.deepEqual({ c: m.creatine, s: m.supps, k: m.kcal }, { c: true, s: { fish_oil: true, beetroot: true }, k: 1800 });
  await call("PATCH", "/api/days/2026-10-12", checkoff("fish_oil", null));
  m = (await call("GET", "/api/state")).body.days["2026-10-12"].manual;
  assert.deepEqual(m.supps, { beetroot: true }, "unchecking one leaves the rest");
  // the log dialog (PUT) sends the whole day, supplements included
  await call("PUT", "/api/days/2026-10-12", { kcal: 1800, creatine: true, supps: { fish_oil: false, beetroot: true } });
  m = (await call("GET", "/api/state")).body.days["2026-10-12"].manual;
  assert.deepEqual(m.supps, { fish_oil: false, beetroot: true });
});
