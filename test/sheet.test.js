// The Google Sheet copy: a read-only backup link, readable tables, the
// sheet's own script (run here against a stand-in for Google Sheets), and
// Restore putting everything back — even onto an empty site.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { sheetScript } from "../js/sheetscript.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "correct horse battery";
let dir, server, base, cookie = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ash-sheet-"));
  const store = await openStore({ file: join(dir, "data.json") });
  server = await createApp({ store, root, password: PASSWORD, secret: "s".repeat(32), requireAuth: true, backupSchedule: false });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  const r = await fetch(`${base}/login`, { method: "POST", body: `password=${encodeURIComponent(PASSWORD)}`, redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 303);
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const anon = (method, path, body, headers = {}) => fetch(`${base}${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const LOG = {
  "2026-10-12": { creatine: true, supps: { fish_oil: true }, foodDone: true, bed: "23:10", wake: "07:05",
    foods: [{ meal: "dinner", name: "Chipotle bowl", qty: 1, unit: "serving", serving: { label: "1 placeholder", amount: 1, unit: "serving" }, kcal: 880, protein: 50, carbs: 90, fat: 30, source: { kind: "placeholder" } },
      { meal: "breakfast", name: "=SUM(A1)", qty: 2, unit: "piece", serving: { label: "1 large", amount: 1, unit: "piece" }, kcal: 140, protein: 12, carbs: 1, fat: 10, time: "07:40" }],
    lifts: [{ exercise: "Bench press", sets: [{ reps: 8, weight: 135, unit: "lb" }, { reps: 6, weight: 145, unit: "lb" }] }] },
  "2026-10-13": { weight: 163.2, kcal: 1900, protein: 150 },
};
let link;

test("a backup link reads the log and nothing else; an empty log is never sent", async () => {
  const r = await call("POST", "/api/backup-links", { name: "Google Sheet" });
  assert.equal(r.status, 200);
  link = r.body.token;
  assert.match(link, /^ahx_/);
  assert.equal((await call("GET", "/api/settings")).body.backupLinks[0].lastUsedAt, null);
  assert.equal((await anon("GET", "/api/backup.json")).status, 401);
  assert.equal((await anon("GET", "/api/backup.json", undefined, { authorization: "Bearer nope" })).status, 401);
  const empty = await anon("GET", "/api/backup.json", undefined, { authorization: `Bearer ${link}` });
  assert.equal(empty.status, 409, "nothing to send — the sheet keeps what it has");
  // the link can't do anything else on the site
  assert.equal((await anon("GET", `/api/state?token=${link}`)).status, 401);
  assert.notEqual((await anon("POST", "/api/ingest", { date: "2026-10-12", steps: 1 }, { authorization: `Bearer ${link}` })).status, 200);
  assert.equal(Object.keys((await call("GET", "/api/state")).body.days).length, 0, "and it can't write");
});

test("the sheet's copy has readable tables worked out like the site, plus a full importable backup", async () => {
  for (const [k, m] of Object.entries(LOG)) await call("PATCH", `/api/days/${k}`, m);
  const goals = (await call("GET", "/api/state")).body.goals;
  await call("PUT", "/api/goals", { ...goals, supplements: [{ id: "creatine", name: "Creatine", dose: "5 g" }, { id: "fish_oil", name: "Fish oil" }] });
  const r = await anon("GET", "/api/backup.json?sheet=1", undefined, { authorization: `Bearer ${link}` });
  assert.equal(r.status, 200);
  const { tables, backup, summary } = r.body;
  assert.equal(backup.format, "ash-health/backup-1");
  assert.equal(summary.days, 2);
  const days = tables.Days;
  assert.equal(days[0][0], "Date");
  const oct12 = days.find((x) => x[0] === "2026-10-12");
  const col = (name) => days[0].indexOf(name);
  assert.equal(oct12[col("Calories")], 1020, "diary entries added up");
  assert.equal(oct12[col("Food log")], "Complete");
  assert.equal(oct12[col("Sleep (h)")], 7.9);
  assert.equal(oct12[col("Lifts")], "Bench press");
  assert.equal(oct12[col("Supplements taken")], "Creatine, Fish oil");
  assert.match(oct12[col("Goals hit")], /^\d+ of \d+$/, "never 5/8, which a sheet reads as a date");
  assert.ok(days.every((row) => row.length === days[0].length), "every row the same width");
  const food = tables["Food diary"];
  assert.deepEqual(food.slice(1).filter((x) => x[0] === "2026-10-12").map((x) => [x[1], x[3], x[11]]),
    [["Breakfast", "'=SUM(A1)", "Custom"], ["Dinner", "Chipotle bowl", "Placeholder"]], "a name that looks like a formula stays text");
  assert.deepEqual(tables.Lifts.slice(1).map((x) => x.slice(0, 6)), [["2026-10-12", "Bench press", 1, 8, 135, "lb"], ["2026-10-12", "Bench press", 2, 6, 145, "lb"]]);
  assert.ok(tables.Settings.some((x) => x[1] === "Fish oil"));
  const links = (await call("GET", "/api/settings")).body.backupLinks;
  assert.ok(links[0].lastUsedAt, "the site shows when the sheet last copied");
});

/* ── the sheet's script, against a stand-in for Google Sheets ─────────── */

function fakeGoogle(fetchSync) {
  const sheets = [];
  const props = {};
  const ui = { alerts: [], answers: [], Button: { OK: "OK", CANCEL: "CANCEL" }, ButtonSet: { OK_CANCEL: 1 },
    alert(m) { this.alerts.push(m); }, prompt() { const a = this.answers.shift(); return { getSelectedButton: () => (a === null ? "CANCEL" : "OK"), getResponseText: () => a ?? "" }; },
    createMenu() { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => {} }; return m; } };
  const makeSheet = (name) => {
    const s = { name, cells: [], hidden: false,
      getName: () => s.name, setName: (n) => { s.name = n; }, getLastRow: () => s.cells.length,
      clear: () => { s.cells = []; }, clearContents: () => { s.cells = []; }, hideSheet: () => { s.hidden = true; },
      setFrozenRows: () => {}, setColumnWidth: () => {},
      getRange: (r, c, nr = 1, nc = 1) => {
        const range = {
          setValues: (v) => {
            assert.equal(v.length, nr); v.forEach((row) => assert.equal(row.length, nc));
            v.forEach((row, i) => { s.cells[r - 1 + i] = [...(s.cells[r - 1 + i] || [])]; row.forEach((x, j) => {
              if (typeof x === "string") assert.ok(x.length <= 50000, "a cell holds at most 50,000 characters");
              s.cells[r - 1 + i][c - 1 + j] = x; }); });
            return range;
          },
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => s.cells[r - 1 + i]?.[c - 1 + j] ?? "")),
          setFontWeight: () => range, setFontSize: () => range, setNumberFormat: () => range, setWrap: () => range,
        };
        return range;
      } };
    return s;
  };
  sheets.push(makeSheet("Sheet1"));
  const ss = {
    getSheets: () => sheets, getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n, i) => { const s = makeSheet(n); sheets.splice(i ?? sheets.length, 0, s); return s; },
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
  };
  const triggers = [];
  const env = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ui },
    UrlFetchApp: { fetch: (url, opt) => fetchSync(url, opt) },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => { const b = { timeBased: () => b, everyDays: (n) => { b.days = n; return b; }, atHour: (h) => { b.hour = h; return b; }, create: () => triggers.push({ getHandlerFunction: () => fn, days: b.days, hour: b.hour }) }; return b; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  };
  return { ss, ui, sheets, triggers, env };
}

function load(script, env) {
  const names = Object.keys(env);
  return new Function(...names, `${script}\nreturn { onOpen, setup, backupNow, restoreToSite };`)(...names.map((n) => env[n]));
}

test("the sheet's script: setup turns on a nightly run, writes every tab, keeps 7 full backups, and survives failures", async () => {
  const script = sheetScript({ site: base, link });
  // UrlFetchApp is synchronous; answer from responses fetched ahead of time.
  const sheetCopy = await fetch(`${base}/api/backup.json?sheet=1`, { headers: { authorization: `Bearer ${link}` } }).then((r) => r.text());
  let answer = { code: 200, text: sheetCopy };
  const seen = [];
  const g = fakeGoogle((url, opt) => { seen.push({ url, opt }); return { getResponseCode: () => answer.code, getContentText: () => answer.text }; });
  const fns = load(script, g.env);
  fns.setup();
  assert.equal(g.triggers.length, 1);
  assert.deepEqual([g.triggers[0].getHandlerFunction(), g.triggers[0].days, g.triggers[0].hour], ["backupNow", 1, 3]);
  fns.setup();
  assert.equal(g.triggers.length, 1, "running setup again never doubles up");
  assert.equal(seen[0].url, `${base}/api/backup.json?sheet=1`);
  assert.equal(seen[0].opt.headers.Authorization, `Bearer ${link}`);
  const names = g.sheets.map((s) => s.name);
  assert.equal(names[0], "About", "the blank first tab becomes About");
  for (const t of ["Days", "Food diary", "Lifts", "Workouts", "My foods", "Meals", "Settings"]) assert.ok(names.includes(t), t);
  const backups = g.sheets.filter((s) => s.name.startsWith("Backup "));
  assert.equal(backups.length, 1);
  assert.ok(backups[0].hidden);
  const about = g.ss.getSheetByName("About").cells;
  assert.match(String(about.find((r) => r[0] === "Result")[1]), /^✓ Backed up 2 days/);
  const daysBefore = JSON.stringify(g.ss.getSheetByName("Days").cells);

  // a bad night changes nothing but the status line
  answer = { code: 409, text: JSON.stringify({ error: "Your log is empty — nothing sent, so your last copy stays as it was" }) };
  fns.backupNow();
  assert.equal(JSON.stringify(g.ss.getSheetByName("Days").cells), daysBefore);
  assert.match(String(g.ss.getSheetByName("About").cells.find((r) => r[0] === "Result")[1]), /^✗ Your log is empty/);
  g.env.UrlFetchApp.fetch = () => { throw new Error("DNS error"); };
  fns.backupNow();
  assert.match(String(g.ss.getSheetByName("About").cells.find((r) => r[0] === "Result")[1]), /Couldn't reach the site/);
  assert.equal(g.sheets.filter((s) => s.name.startsWith("Backup ")).length, 1);

  // nine more nights → only the newest 7 kept
  const copy = JSON.parse(sheetCopy);
  for (let d = 1; d <= 9; d += 1) {
    const night = JSON.stringify({ ...copy, takenAt: `2026-11-0${d}T03:00:00.000Z` });
    g.env.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => night });
    load(script, g.env).backupNow();
  }
  const kept = g.sheets.filter((s) => s.name.startsWith("Backup ")).map((s) => s.name).sort();
  assert.deepEqual(kept, ["03", "04", "05", "06", "07", "08", "09"].map((d) => `Backup 2026-11-${d}`));
});

test("Restore from the sheet: wrong password refused; right one brings everything back to an empty site and re-links the sheet", async () => {
  const script = sheetScript({ site: base, link });
  const sheetCopy = await fetch(`${base}/api/backup.json?sheet=1`, { headers: { authorization: `Bearer ${link}` } }).then((r) => r.text());
  // a backup bigger than one cell, to prove it's split and joined back exactly
  const big = JSON.parse(sheetCopy);
  big.backup.days["2026-10-12"].manual.foods[1].notes = "x".repeat(290);
  for (let i = 0; i < 400; i += 1) {
    const k = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    big.backup.days[k] = { manual: { foodDone: true, foods: [{ id: `f${i}`, meal: "lunch", name: `Lunch ${i}`, qty: 1, unit: "serving", serving: { label: "1 serving", amount: 1, unit: "serving" }, kcal: 600 + i, protein: 40, carbs: 60, fat: 20, fiber: 8, source: { kind: "custom" } }] }, apple: { steps: 8000 + i } };
  }
  const bigText = JSON.stringify(big);
  let posted = null;
  const g = fakeGoogle((url, opt) => {
    if (url.endsWith("/api/restore")) { posted = JSON.parse(opt.payload); return { getResponseCode: () => 202, getContentText: () => "{}" }; }
    return { getResponseCode: () => 200, getContentText: () => bigText };
  });
  const fns = load(script, g.env);
  fns.backupNow();
  const tab = g.sheets.find((s) => s.name.startsWith("Backup "));
  assert.ok(tab.cells.length > 2, "split across several cells");

  // what the sheet sends is exactly what it stored
  g.ui.answers = ["", "wrong password"];
  fns.restoreToSite();
  assert.deepEqual(posted.backup, big.backup);
  assert.equal(posted.link, link);

  // now against the real site: everything gone (the worst case), then restored
  await call("DELETE", "/api/days");
  await call("DELETE", `/api/backup-links/${(await call("GET", "/api/settings")).body.backupLinks[0].id}`);
  assert.equal(Object.keys((await call("GET", "/api/state")).body.days).length, 0);
  const wrong = await anon("POST", "/api/restore", posted);
  assert.equal(wrong.status, 401);
  assert.equal(Object.keys((await call("GET", "/api/state")).body.days).length, 0, "nothing changed");
  const ok = await anon("POST", "/api/restore", { ...posted, password: PASSWORD });
  assert.equal(ok.status, 200);
  const st = (await call("GET", "/api/state")).body;
  assert.equal(Object.keys(st.days).length, Object.keys(big.backup.days).length);
  assert.equal(st.days["2026-10-12"].manual.foods.find((f) => f.name === "Chipotle bowl").source.kind, "placeholder");
  assert.equal(st.days["2026-10-12"].manual.lifts[0].sets[1].weight, 145);
  assert.deepEqual(st.days["2026-10-12"].manual.supps, { fish_oil: true });
  assert.deepEqual(st.goals.supplements.map((s) => s.name), ["Creatine", "Fish oil"]);
  // the sheet's link works again, so tomorrow night's copy carries on
  assert.equal((await anon("GET", "/api/backup.json", undefined, { authorization: `Bearer ${link}` })).status, 200);
  // restoring over a log that has data backs that data up first, so it can be undone
  await anon("POST", "/api/restore", { ...posted, password: PASSWORD });
  const bk = (await call("GET", "/api/backups")).body.snapshots;
  assert.ok(bk.some((b) => b.reason === "Before restoring from your Google Sheet" && b.kind === "safety"));
});

test("the restore menu explains itself when there's nothing to restore, and cancelling does nothing", () => {
  const g = fakeGoogle(() => { throw new Error("should not be called"); });
  const fns = load(sheetScript({ site: base, link }), g.env);
  fns.restoreToSite();
  assert.match(g.ui.alerts[0], /no backups in this sheet yet/);
});
