/* ──────────────────────────────────────────────────────────────────────────
   Progress photos. The page shrinks each photo to at most 1600 px and
   re-encodes it as JPEG before sending; the server then checks it really
   is a JPEG and strips every metadata segment (EXIF — which can carry the
   phone's GPS location — XMP, ICC, comments) before storing it.

   Photos are only ever sent to a signed-in session, never cached by the
   browser or anything in between, and never put on a public link. They're
   kept out of automatic snapshots, the Google Sheet copy and JSON exports
   (each would be many megabytes); download or delete them one by one.
   ────────────────────────────────────────────────────────────────────────── */
import { randomBytes } from "node:crypto";

export const POSES = ["front", "side", "back"];
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_PHOTOS = 1000;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * The JPEG with every APPn (1–15) and COM segment removed — APP0 (JFIF)
 * is kept, it only says how to read the pixels. Returns null if the file
 * isn't a well-formed JPEG.
 */
export function stripJpegMeta(buf) {
  if (!isJpeg(buf)) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); return Buffer.concat(out); }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const seg = buf.subarray(i, i + 2 + len);
    const meta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!meta) out.push(seg);
    i += 2 + len;
    if (marker === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); } // start of scan: the rest is image data
  }
  return null;
}

/** Check and clean an upload: { date, pose, data (base64 JPEG), width, height }. */
export function readUpload(body) {
  if (!body || typeof body !== "object") return { error: "Send { date, pose, data }" };
  const date = String(body.date || "");
  if (!KEY_RE.test(date)) return { error: "Pick the date the photo was taken" };
  const pose = POSES.includes(body.pose) ? body.pose : null;
  if (!pose) return { error: "Pose must be front, side or back" };
  if (typeof body.data !== "string" || !body.data) return { error: "No photo in the upload" };
  const raw = Buffer.from(body.data.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  if (raw.length > MAX_PHOTO_BYTES) return { error: "That photo is too large (over 4 MB after shrinking)" };
  const clean = stripJpegMeta(raw);
  if (!clean) return { error: "That isn't a JPEG photo" };
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 10000 ? v : null);
  const info = {
    id: `ph_${randomBytes(9).toString("base64url")}`,
    date, pose, width: dim(body.width), height: dim(body.height), bytes: clean.length,
    createdAt: new Date().toISOString(),
  };
  return { info, data: clean };
}
