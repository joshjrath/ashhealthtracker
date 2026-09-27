/* ──────────────────────────────────────────────────────────────────────────
   Apple Health → day log.

   Apple Health has no web API: the data only leaves the iPhone when an app
   there sends it. Two senders are understood:

   1. Health Auto Export (iOS app, "REST API" automation, JSON). Its payload:
        { data: { metrics: [{ name, units, data: [...] }], workouts: [...] } }
      Works with "Aggregate data" on (one entry per day — recommended) or
      off (one entry per sample).

   2. Anything simpler, e.g. an iOS Shortcut, posting day fields directly:
        { date: "2026-09-27", steps: 11240, weight: 162.8, ... }
        { days: { "2026-09-27": { ... } } }   or an array of { date, ... }

   Either way the result is { "YYYY-MM-DD": { field: value } } holding only
   the fields the payload actually carried, so a merge never erases what
   was logged by hand (creatine, say).
   ────────────────────────────────────────────────────────────────────────── */

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/** Fields a sender may set, and how to clean each. */
const FIELDS = {
  weight: (v) => round1(num(v)),
  kcal: (v) => int(v),
  protein: (v) => int(v),
  carbs: (v) => int(v),
  fat: (v) => int(v),
  fiber: (v) => int(v),
  steps: (v) => int(v),
  sleepMins: (v) => int(v),
  bed: (v) => (typeof v === "string" && TIME_RE.test(v.trim()) ? pad(v.trim()) : undefined),
  wake: (v) => (typeof v === "string" && TIME_RE.test(v.trim()) ? pad(v.trim()) : undefined),
  workout: (v) => bool(v),
  creatine: (v) => bool(v),
};

function num(v) {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
const int = (v) => { const n = num(v); return n === undefined ? undefined : Math.round(n); };
const round1 = (n) => (n === undefined ? undefined : Math.round(n * 10) / 10);
const pad = (hhmm) => hhmm.padStart(5, "0");
function bool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "yes") return true;
  if (v === 0 || v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/** Keep only known fields with valid values. */
export function cleanDay(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, fix] of Object.entries(FIELDS)) {
    if (!(k in raw)) continue;
    const v = fix(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/* ── Apple's timestamps ────────────────────────────────────────────────── */

/**
 * "2026-09-27 06:55:12 -0700" (Health Auto Export) or ISO. The wall-clock
 * date and time are read straight off the string — they are already in the
 * phone's local time, which is the day the person lived.
 */
export function parseStamp(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const [, date, hh = "00", mm = "00", ss = "00", tz] = m;
  let ms = null;
  if (tz) {
    const iso = `${date}T${hh}:${mm}:${ss}${tz === "Z" ? "Z" : tz.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")}`;
    const t = Date.parse(iso);
    ms = Number.isNaN(t) ? null : t;
  }
  return { date, hour: Number(hh), time: `${hh}:${mm}`, ms };
}

/** The morning a sleep sample belongs to: anything from 20:00 counts toward tomorrow. */
function nightOf(stamp) {
  if (stamp.hour < 20) return stamp.date;
  const d = new Date(`${stamp.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ── Health Auto Export ────────────────────────────────────────────────── */

/** Metric names as the app writes them, including older and alternate spellings. */
const SUMS = {
  step_count: "steps",
  steps: "steps",
  dietary_energy: "kcal",
  dietary_energy_consumed: "kcal",
  protein: "protein",
  dietary_protein: "protein",
  carbohydrates: "carbs",
  dietary_carbohydrates: "carbs",
  total_fat: "fat",
  dietary_fat_total: "fat",
  fiber: "fiber",
  dietary_fiber: "fiber",
};
const WEIGHTS = new Set(["weight_body_mass", "body_mass", "weight"]);
const SLEEPS = new Set(["sleep_analysis", "sleep"]);
const ASLEEP = /^(asleep|core|deep|rem|asleepcore|asleepdeep|asleeprem|asleepunspecified)$/i;

function toPounds(qty, units) {
  return /^kg$/i.test(units || "") ? qty * 2.20462262 : qty;
}
function toKcal(qty, units) {
  return /^kj$/i.test(units || "") ? qty / 4.184 : qty;
}

function sleepEntries(metric, put) {
  const byNight = new Map();
  for (const e of metric.data || []) {
    if (e.sleepStart && e.sleepEnd) {
      // Aggregated: one summary per night.
      const start = parseStamp(e.sleepStart), end = parseStamp(e.sleepEnd);
      if (!start || !end) continue;
      const hours = num(e.totalSleep ?? e.asleep);
      put(end.date, { bed: start.time, wake: end.time, ...(hours ? { sleepMins: Math.round(hours * 60) } : {}) });
      continue;
    }
    // Per sample: stage segments with a start, an end and a stage name.
    const start = parseStamp(e.startDate ?? e.start), end = parseStamp(e.endDate ?? e.end);
    if (!start || !end) continue;
    const stage = String(e.value ?? e.stage ?? "Asleep").replace(/\s+/g, "");
    if (!ASLEEP.test(stage)) continue;
    if (end.hour >= 14 && end.hour < 20 && start.hour >= 12) continue; // an afternoon nap
    const night = nightOf(start);
    const n = byNight.get(night) || { bed: start, wake: end, mins: 0 };
    if ((start.ms ?? 0) < (n.bed.ms ?? 0)) n.bed = start;
    if ((end.ms ?? 0) > (n.wake.ms ?? 0)) n.wake = end;
    if (start.ms != null && end.ms != null) n.mins += (end.ms - start.ms) / 60000;
    byNight.set(night, n);
  }
  for (const [night, n] of byNight) {
    put(night, { bed: n.bed.time, wake: n.wake.time, ...(n.mins > 0 ? { sleepMins: Math.round(n.mins) } : {}) });
  }
}

export function fromHealthAutoExport(payload) {
  const root = payload?.data ?? payload;
  const out = {};
  const put = (key, fields) => {
    if (!KEY_RE.test(key)) return;
    out[key] = { ...(out[key] || {}), ...fields };
  };

  const sums = {}; // key → field → total
  const weights = {}; // key → { t, v }
  for (const metric of root?.metrics || []) {
    const name = String(metric?.name || "").toLowerCase();
    if (SLEEPS.has(name)) { sleepEntries(metric, put); continue; }
    const field = SUMS[name];
    const isWeight = WEIGHTS.has(name);
    if (!field && !isWeight) continue;
    for (const e of metric.data || []) {
      const st = parseStamp(e.date ?? e.startDate);
      const qty = num(e.qty ?? e.Avg ?? e.avg);
      if (!st || qty === undefined) continue;
      if (isWeight) {
        const t = st.ms ?? 0;
        if (!weights[st.date] || t >= weights[st.date].t) weights[st.date] = { t, v: toPounds(qty, metric.units) };
      } else {
        const v = field === "kcal" ? toKcal(qty, metric.units) : qty;
        (sums[st.date] ||= {})[field] = (sums[st.date][field] || 0) + v;
      }
    }
  }
  for (const [key, fields] of Object.entries(sums)) put(key, cleanDay(fields));
  for (const [key, w] of Object.entries(weights)) put(key, cleanDay({ weight: w.v }));

  for (const w of root?.workouts || []) {
    const st = parseStamp(w.start ?? w.startDate ?? w.date);
    if (st) put(st.date, { workout: true });
  }
  return out;
}

/* ── entry point ───────────────────────────────────────────────────────── */

/** Any accepted payload → { key: fields }. Throws on a shape it doesn't know. */
export function parseIngest(body) {
  if (!body || typeof body !== "object") throw new Error("Expected a JSON object");

  const hae = body.data && (Array.isArray(body.data.metrics) || Array.isArray(body.data.workouts));
  if (hae || Array.isArray(body.metrics)) return fromHealthAutoExport(body);

  const out = {};
  const add = (key, raw) => {
    const k = typeof key === "string" ? parseStamp(key)?.date : null;
    if (!k || !KEY_RE.test(k)) return;
    const d = cleanDay(raw);
    if (Object.keys(d).length) out[k] = { ...(out[k] || {}), ...d };
  };
  if (Array.isArray(body)) body.forEach((d) => add(d?.date, d));
  else if (body.days && typeof body.days === "object" && !Array.isArray(body.days)) {
    for (const [k, d] of Object.entries(body.days)) add(k, d);
  } else if (Array.isArray(body.days)) body.days.forEach((d) => add(d?.date, d));
  else if (body.date) add(body.date, body);
  else throw new Error("Unrecognised payload: send Health Auto Export JSON, or { date, steps, weight, ... }");
  return out;
}
