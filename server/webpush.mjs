/* ──────────────────────────────────────────────────────────────────────────
   Web Push: sending a notification to a browser that allowed it, so it can
   show even when the site isn't open.

   Two standards, no third-party code:
     · RFC 8291 — the message is encrypted for that one browser
       (ECDH P-256 + HKDF + AES-128-GCM, "aes128gcm" content coding, RFC 8188)
     · RFC 8292 — VAPID: the server signs each request (ES256 JWT) with a
       key pair made once and kept in the database, so push services know
       it's this site

   The push service (Google's, Mozilla's, Apple's) holds the message until
   the browser comes online. Whether a closed browser shows it is up to the
   browser and the OS; the site can only hand it over.
   ────────────────────────────────────────────────────────────────────────── */
import { createECDH, createHmac, createCipheriv, randomBytes, generateKeyPairSync, createPrivateKey, sign } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** A new VAPID key pair: { publicKey (65-byte point, base64url), privateKey (32 bytes, base64url) }. */
export function makeVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])), privateKey: priv.d };
}

/** A key object for signing from the stored pair. */
function signingKey({ publicKey, privateKey }) {
  const pt = unb64u(publicKey);
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: privateKey, x: b64u(pt.subarray(1, 33)), y: b64u(pt.subarray(33, 65)) }, format: "jwk" });
}

/** The VAPID Authorization header for a push endpoint (RFC 8292). */
export function vapidHeader(endpoint, vapid, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: signingKey(vapid), dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/**
 * Encrypt `plaintext` for a subscription (RFC 8291, one aes128gcm record).
 * `asPrivate` and `salt` are only passed in tests, to check against the RFC's example.
 */
export function encrypt(plaintext, { p256dh, auth }, { asPrivate, salt = randomBytes(16), rs = 4096 } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = createECDH("prime256v1");
  if (asPrivate) ecdh.setPrivateKey(unb64u(asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, secret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02: the last (only) record
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Send one push. → { ok, status, gone } — `gone` means the browser
 * unsubscribed (404/410) and the subscription should be forgotten.
 */
export async function sendPush(sub, payload, { vapid, subject, ttl = 24 * 3600, urgency = "normal", fetchImpl = fetch } = {}) {
  const body = encrypt(JSON.stringify(payload), sub.keys);
  const res = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
      ttl: String(ttl), urgency, authorization: vapidHeader(sub.endpoint, vapid, subject),
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
