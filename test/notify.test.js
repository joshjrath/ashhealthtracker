// Notifications: the service (dedupe, cooldowns, quiet hours, digests, limits, cancel),
// the rules against real-shaped data, the HTTP API, and Web Push encryption.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecipheriv, createECDH, createHmac, generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { createNotifier, localNow, inQuiet, cleanNotifySettings, DEFAULT_NOTIFY } from "../server/notify.mjs";
import { runRules } from "../server/notify-rules.mjs";
import { encrypt, vapidHeader, makeVapidKeys } from "../server/webpush.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), "ash-notify-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });
let n = 0;
const freshStore = () => openStore({ file: join(dir, `s${n++}.json`) });
const H = 3600_000;

test("local time follows your time zone", () => {
  const at = Date.parse("2026-11-23T03:30:00Z");
  assert.deepEqual(localNow("America/New_York", at), { key: "2026-11-22", minutes: 22 * 60 + 30, weekday: 0 });
  assert.deepEqual(localNow("Asia/Tokyo", at).key, "2026-11-23");
  assert.equal(inQuiet({ quiet: { on: true, from: "22:00", to: "07:00" } }, 23 * 60), true);
  assert.equal(inQuiet({ quiet: { on: true, from: "22:00", to: "07:00" } }, 6 * 60 + 59), true);
  assert.equal(inQuiet({ quiet: { on: true, from: "22:00", to: "07:00" } }, 7 * 60), false);
  assert.equal(cleanNotifySettings({ timeZone: "Not/AZone" }).timeZone, "", "an unknown zone is ignored");
  assert.equal(cleanNotifySettings({ categories: { nutrition: "loud" }, maxPerDay: 7 }).categories.nutrition, "on");
  assert.deepEqual(cleanNotifySettings({}).reminders.meal, { on: false, time: "13:00" }, "reminders are off by default");
});

test("same thing twice is sent once; new information replaces it; cooldowns and repeats hold", async () => {
  let t = Date.parse("2026-11-23T15:00:00Z");
  const store = await freshStore();
  const nt = createNotifier({ store, now: () => t });
  await nt.saveSettings({ timeZone: "UTC", quiet: { on: false } });
  const base = { type: "x", category: "weight", priority: "important", key: "wt:plateau", title: "Flat", fp: "confirmed", repeat: true, cooldownH: 24 };
  assert.ok(await nt.emit(base));
  assert.equal(await nt.emit(base), null, "nothing new");
  t += 25 * H;
  assert.ok(await nt.emit(base), "after the cooldown, a repeat may come back");
  const l1 = await nt.list();
  assert.equal(l1.items.filter((i) => i.key === "wt:plateau").length, 1, "one live notification per key");
  assert.ok(await nt.emit({ ...base, fp: "resolved", title: "Moving again" }), "new information replaces it");
  assert.equal((await nt.list()).items.find((i) => i.key === "wt:plateau").title, "Moving again");
  assert.equal(await nt.emit({ ...base, key: "ins:tdee", fp: "2100", minGapH: 72 }) !== null, true);
  t += H;
  assert.equal(await nt.emit({ ...base, key: "ins:tdee", fp: "2250", minGapH: 72 }), null, "a changed value can't flap within its minimum gap");
});

test("off topics, quiet hours, the daily limit and digests", async () => {
  let t = Date.parse("2026-11-23T23:00:00Z"); // 23:00 UTC: quiet
  const store = await freshStore();
  const nt = createNotifier({ store, now: () => t });
  await nt.saveSettings({ timeZone: "UTC", maxPerDay: 3, categories: { recovery: "off", nutrition: "daily" } });
  const mk = (k, extra = {}) => ({ type: "x", category: "weight", priority: "info", key: k, title: k, ...extra });
  assert.equal(await nt.emit(mk("rem:x", { priority: "reminder" })), null, "no reminders in quiet hours");
  assert.equal(await nt.emit(mk("r1", { category: "recovery" })), null, "topic off");
  assert.ok(await nt.emit(mk("c1", { category: "recovery", priority: "critical" })), "critical is never off");
  const held = await nt.emit(mk("n1", { category: "nutrition" }));
  assert.equal(held.held, "daily", "a digest topic is held");
  t = Date.parse("2026-11-24T12:00:00Z");
  for (const k of ["a", "b", "c", "d"]) await nt.emit(mk(k));
  const l = await nt.list();
  assert.equal(l.items.filter((i) => ["a", "b", "c", "d"].includes(i.key)).length, 3, "past the daily limit the rest wait");
  assert.equal(l.held, 2, "n1 and d are waiting for the digest");
  const made = await nt.digest();
  assert.equal(made.length, 1);
  assert.match(made[0].title, /Daily digest: 2 updates/);
  assert.equal((await nt.list()).held, 0);
  assert.deepEqual(await nt.digest(), [], "once a day");
});

test("reminders cancel themselves; read and dismiss", async () => {
  const t = Date.parse("2026-11-23T15:00:00Z");
  const store = await freshStore();
  const nt = createNotifier({ store, now: () => t });
  await nt.saveSettings({ timeZone: "UTC" });
  await nt.emit({ type: "reminder.meal", category: "nutrition", priority: "reminder", key: "rem:meal:2026-11-23", title: "Log meals?" });
  await nt.emit({ type: "x", category: "weight", priority: "info", key: "k2", title: "Other" });
  assert.equal(await nt.cancel("rem:meal:*"), 1);
  let l = await nt.list();
  assert.deepEqual(l.items.map((i) => i.key), ["k2"]);
  await nt.read("all");
  l = await nt.list();
  assert.equal(l.unread, 0);
  await nt.dismiss("read");
  assert.equal((await nt.list()).items.length, 0);
});

test("rules read your real data: reminders respect what's done, nothing old floods in on the first run", async () => {
  const store = await freshStore();
  let t = Date.parse("2026-11-23T18:00:00Z"); // Monday 18:00 UTC
  const today = "2026-11-23";
  const add = (k, n) => new Date(Date.parse(`${k}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  // three weeks of lifting with a new best today, weigh-ins, complete food days low on protein
  for (let i = 21; i >= 1; i--) {
    const k = add(today, -i);
    await store.putManual(k, { weight: 170 - (21 - i) * 0.1, foods: [{ id: `f${i}`, meal: "lunch", name: "Lunch", qty: 1, unit: "serving", serving: { label: "1", amount: 1, unit: "serving" }, kcal: 1900, protein: 110, carbs: 200, fat: 60, fiber: 25, source: { kind: "custom" } }], foodDone: true, lifts: i % 3 === 0 ? [{ id: `l${i}`, exercise: "Bench press", sets: [{ reps: 5, weight: 185, unit: "lb" }] }] : undefined });
  }
  await store.setMeta("goals", { protein: 150, startWeight: 172, goalWeight: 150, tracked: ["protein"] });
  const nt = createNotifier({ store, now: () => t });
  await nt.saveSettings({ timeZone: "UTC", reminders: { meal: { on: true, time: "13:00" }, weighIn: { on: true, time: "09:00" } } });
  const base = { store, cfg: { tokens: [] }, storage: { persistent: true }, at: t };
  const first = await runRules(nt, base);
  const keys = first.map((i) => i.key);
  assert.ok(keys.includes(`rem:meal:${today}`), "nothing logged today → meal reminder");
  assert.ok(keys.includes(`rem:weigh:${today}`), "weighs in regularly, not yet today → weigh-in reminder");
  assert.ok(keys.some((k) => k.startsWith("nut:protein:")), "protein under target on most complete days");
  assert.ok(!keys.some((k) => k.startsWith("wt:ms:")), "a milestone passed before the first run isn't announced");
  // log a meal and a weigh-in: both reminders go away on the next run
  await store.putManual(today, { weight: 167.8, foods: [{ id: "t1", meal: "lunch", name: "Lunch", qty: 1, unit: "serving", serving: { label: "1", amount: 1, unit: "serving" }, kcal: 600, protein: 50, source: { kind: "custom" } }] });
  t += 10 * 60_000;
  await runRules(nt, { ...base, at: t });
  const live = (await nt.list()).items.map((i) => i.key);
  assert.ok(!live.includes(`rem:meal:${today}`) && !live.includes(`rem:weigh:${today}`), "done → reminders cancelled");
  // a new best after the first run is announced, once
  await store.putManual(today, { weight: 167.8, lifts: [{ id: "lt", exercise: "Bench press", sets: [{ reps: 5, weight: 205, unit: "lb" }] }] });
  t += 10 * 60_000;
  const third = await runRules(nt, { ...base, at: t });
  assert.ok(third.some((i) => i.key === `fit:pr:${today}`), "new PR announced");
  t += 10 * 60_000;
  assert.ok(!(await runRules(nt, { ...base, at: t })).some((i) => i.key === `fit:pr:${today}`), "and not again");
  // temporary storage is critical; a stale sync is important
  const sys = await runRules(nt, { store, cfg: { tokens: [{ id: "x" }] }, storage: { persistent: false }, at: t });
  assert.ok(sys.some((i) => i.key === "sys:storage" && i.priority === "critical"));
});

test("Web Push: encryption matches RFC 8291's worked example, a browser can decrypt it, and the VAPID signature verifies", () => {
  const out = encrypt(Buffer.from("When I grow up, I want to be a watermelon"), {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url") });
  assert.equal(out.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");

  // the browser's side, written from the RFC's receiving steps
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const msg = encrypt(Buffer.from(JSON.stringify({ title: "hi" })), { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
  const salt = msg.subarray(0, 16), idlen = msg[20], asPub = msg.subarray(21, 21 + idlen), ct = msg.subarray(21 + idlen);
  const h = (k, d) => createHmac("sha256", k).update(d).digest();
  const ikm = h(h(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const d = createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.at(-1), 2, "last-record delimiter");
  assert.deepEqual(JSON.parse(plain.subarray(0, -1)), { title: "hi" });

  const v = makeVapidKeys();
  const hdr = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", v, "mailto:me@example.com", 1_800_000_000);
  const [, jwt, k] = hdr.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [h64, b64, s64] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(b64, "base64url")), { aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 43200, sub: "mailto:me@example.com" });
  const pt = Buffer.from(v.publicKey, "base64url");
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pt.subarray(1, 33).toString("base64url"), y: pt.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h64}.${b64}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s64, "base64url")));
});

test("over HTTP: list, read, dismiss, settings, push sign-up and delivery; forgotten when the browser unsubscribes", async () => {
  const store = await freshStore();
  const sent = [];
  let gone = false;
  const pushFetch = async (url, init) => { sent.push({ url, init }); return { status: gone ? 410 : 201 }; };
  const server = await createApp({ store, root, password: "", secret: "s".repeat(32), requireAuth: false, backupSchedule: false, notifySchedule: false, pushFetch });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const s = (await call("GET", "/api/notifications/settings")).body;
    assert.equal(s.email, false, "no email service — said plainly");
    assert.match(s.push.publicKey, /^B[\w-]{80,}$/);
    const ua = createECDH("prime256v1"); ua.generateKeys();
    const sub = { endpoint: "https://push.example.com/abc", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
    assert.equal((await call("POST", "/api/push/subscribe", { subscription: { endpoint: "http://nope" } })).status, 400);
    assert.equal((await call("POST", "/api/push/subscribe", { subscription: sub })).body.devices, 1);
    const test1 = await call("POST", "/api/push/test", {});
    assert.equal(test1.body.sent, 1);
    assert.equal(sent[0].url, sub.endpoint);
    assert.equal(sent[0].init.headers["content-encoding"], "aes128gcm");
    assert.match(sent[0].init.headers.authorization, /^vapid t=/);
    // a security event becomes a notification and is pushed
    await call("POST", "/api/tokens", { name: "iPhone" });
    await new Promise((r) => setTimeout(r, 50));
    let l = (await call("GET", "/api/notifications")).body;
    assert.ok(l.items.some((i) => i.type === "security.token"));
    assert.equal((await call("GET", "/api/state")).body.notify.unread, l.unread);
    await call("POST", "/api/notifications/read", { ids: "all" });
    assert.equal((await call("GET", "/api/notifications")).body.unread, 0);
    // the browser unsubscribed: the next push gets 410 and the device is dropped
    gone = true;
    await call("POST", "/api/push/test", {});
    assert.equal((await call("GET", "/api/notifications/settings")).body.push.devices.length, 0);
    const saved = (await call("PUT", "/api/notifications/settings", { reminders: { workout: { on: true, time: "18:30" } }, quiet: { on: false } })).body.settings;
    assert.deepEqual(saved.reminders.workout, { on: true, time: "18:30" });
    l = (await call("POST", "/api/notifications/dismiss", { ids: "all" })).body;
    assert.equal(l.items.length, 0);
    // push keys never leave the server
    const st = (await call("GET", "/api/state")).body;
    assert.ok(!JSON.stringify(st).includes(s.push.publicKey.slice(0, 20)) || !JSON.stringify(st).includes("privateKey"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
