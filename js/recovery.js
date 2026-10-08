/* ──────────────────────────────────────────────────────────────────────────
   A recovery copy of your log, kept in this browser.

   The server keeps its own backups, but those live wherever the log
   lives — if the server's storage itself is wiped, they go with it. So
   each browser you open the site in also keeps the latest copy of your
   log (the same file Settings → Export writes). If the site ever comes
   back empty, the page offers to put it back.

   It's refreshed at most every 10 minutes, and only from real data —
   never from sample days or an empty log. Nothing here is sent anywhere
   unless you press Restore.
   ────────────────────────────────────────────────────────────────────────── */

const DB = "ash-health";
const STORE = "recovery";
const KEY = "latest";
const EVERY_MS = 10 * 60_000;

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("No IndexedDB"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** { savedAt, days, foods, doc } or null. Never throws: a browser without storage just has no copy. */
export async function loadCopy() {
  try {
    return (await run("readonly", (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

/** Keep `doc` (an export) as this browser's copy, unless a fresh one was saved moments ago. */
export async function saveCopy(doc, { force = false } = {}) {
  const days = Object.keys(doc?.days || {}).length;
  const foods = doc?.library?.foods?.length || 0;
  if (!days && !foods) return false; // never overwrite a good copy with an empty log
  try {
    const prev = await loadCopy();
    if (!force && prev && Date.now() - Date.parse(prev.savedAt) < EVERY_MS && prev.days === days) return false;
    await run("readwrite", (s) => s.put({ savedAt: new Date().toISOString(), days, foods, doc }, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function forgetCopy() {
  try { await run("readwrite", (s) => s.delete(KEY)); } catch { /* nothing to forget */ }
}
