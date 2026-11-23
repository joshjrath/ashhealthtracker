// Progress photos: private, metadata stripped, only JPEGs, only signed in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { stripJpegMeta } from "../server/photos.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, store, server, base;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ash-ph-"));
  store = await openStore({ databaseUrl: process.env.TEST_DATABASE_URL, file: join(dir, "db.json") });
  for (const k of ["auth", "tokens"]) await store.setMeta(k, null);
  server = await createApp({ store, root, password: "hunter2", secret: "s".repeat(32), ingestToken: "tok123", requireAuth: true, notifySchedule: false });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});
const login = async () => (await fetch(`${base}/login`, { method: "POST", body: "password=hunter2", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" } })).headers.get("set-cookie").split(";")[0];

/** A tiny JPEG-shaped file: SOI, APP0 (JFIF), APP1 (EXIF with a fake GPS tag), COM, a quant table, SOS + data, EOI. */
function jpegWithExif() {
  const seg = (marker, body) => { const b = Buffer.from(body); const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(b.length + 2, 2); return Buffer.concat([h, b]); };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
    seg(0xe1, "Exif\0\0GPSLatitude=40.7128N;GPSLongitude=74.0060W"),
    seg(0xfe, "a comment"),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test("metadata segments are stripped; the image data is kept", () => {
  const src = jpegWithExif();
  const out = stripJpegMeta(src);
  assert.ok(out);
  assert.ok(!out.includes(Buffer.from("GPSLatitude")), "no GPS");
  assert.ok(!out.includes(Buffer.from("a comment")), "no comment");
  assert.ok(out.includes(Buffer.from("JFIF")), "JFIF header kept");
  assert.ok(out.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56])), "scan data kept");
  assert.equal(stripJpegMeta(Buffer.from("\x89PNG\r\n")), null);
});

test("photos need a session; uploads are cleaned; images are private and uncached", async () => {
  assert.equal((await fetch(`${base}/api/photos`)).status, 401);
  const c = await login();
  const h = { cookie: c, "content-type": "application/json" };
  const bad = await fetch(`${base}/api/photos`, { method: "POST", headers: h, body: JSON.stringify({ date: "2026-11-20", pose: "front", data: Buffer.from("not a jpeg").toString("base64") }) });
  assert.equal(bad.status, 400);
  const wrongPose = await fetch(`${base}/api/photos`, { method: "POST", headers: h, body: JSON.stringify({ date: "2026-11-20", pose: "top", data: jpegWithExif().toString("base64") }) });
  assert.equal(wrongPose.status, 400);
  const ok = await fetch(`${base}/api/photos`, { method: "POST", headers: h, body: JSON.stringify({ date: "2026-11-20", pose: "front", data: jpegWithExif().toString("base64"), width: 600, height: 800 }) });
  assert.equal(ok.status, 200);
  const { photo } = await ok.json();
  assert.match(photo.id, /^ph_/);
  // signed out: no list, no image
  assert.equal((await fetch(`${base}/api/photos/${photo.id}`)).status, 401);
  const img = await fetch(`${base}/api/photos/${photo.id}`, { headers: { cookie: c } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.match(img.headers.get("cache-control"), /no-store/);
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.ok(!bytes.includes(Buffer.from("GPSLatitude")));
  const state = await (await fetch(`${base}/api/state`, { headers: { cookie: c } })).json();
  assert.ok(state.photos.some((p) => p.id === photo.id));
  assert.ok(!JSON.stringify(state).includes(bytes.subarray(0, 40).toString("base64")), "state lists photos, never their data");
  // a JSON body is required (so another site can't post a photo with your cookie)
  const form = await fetch(`${base}/api/photos`, { method: "POST", headers: { cookie: c, "content-type": "text/plain" }, body: "x" });
  assert.equal(form.status, 415);
  assert.equal((await fetch(`${base}/api/photos/${photo.id}`, { method: "DELETE", headers: { cookie: c } })).status, 200);
  assert.equal((await fetch(`${base}/api/photos/${photo.id}`, { headers: { cookie: c } })).status, 404);
});
