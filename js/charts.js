/* ──────────────────────────────────────────────────────────────────────────
   SVG builders. Each returns a string. The wide charts take a measured pixel
   width so their text never scales — app.js re-draws them on resize.

   Mark rules, kept everywhere: 2px lines with round caps, 4px rounded bar
   ends square at the baseline, hairline solid gridlines, a 2px surface ring
   on dots, text in ink tokens (never the series colour).
   ────────────────────────────────────────────────────────────────────────── */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SURFACE = "#18181C";

/** "Title|line|line" — the first line is the tooltip heading. */
export const tip = (...lines) => `data-tip="${esc(lines.filter(Boolean).join("|"))}"`;

/** A clean step for an axis: 1, 2, 2.5, 5 × 10ⁿ. */
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

/* ── rings ─────────────────────────────────────────────────────────────── */

/**
 * A progress ring. `pct` 0..1 (capped); the track is the same hue, faint.
 * `zone` [a, b] as fractions of the ring draws a thin band outside it.
 * `mark` puts a tick at a fraction (the exact target inside a zone).
 */
export function ring({ pct, size = 120, stroke = 10, color, zone, mark, label = "" }) {
  const cx = size / 2;
  const r = (size - stroke) / 2 - (zone ? 7 : 1);
  const c = 2 * Math.PI * r;
  const p = clamp(pct || 0, 0, 1);
  const over = clamp((pct || 0) - 1, 0, 1); // a second lap past the target
  const off = c * (1 - p);
  const arcAt = (f, rr) => {
    const a = -Math.PI / 2 + f * 2 * Math.PI;
    return [cx + rr * Math.cos(a), cx + rr * Math.sin(a)];
  };
  let extra = "";
  if (zone) {
    const rz = r + stroke / 2 + 5;
    const [x0, y0] = arcAt(zone[0], rz);
    const [x1, y1] = arcAt(zone[1], rz);
    const large = zone[1] - zone[0] > 0.5 ? 1 : 0;
    extra += `<path class="zone" d="M${x0.toFixed(2)},${y0.toFixed(2)} A${rz},${rz} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}"
      style="stroke:${color}" stroke-width="3" stroke-linecap="round" fill="none"/>`;
  }
  if (mark != null) {
    const [a0, b0] = arcAt(mark, r - stroke / 2 - 3);
    const [a1, b1] = arcAt(mark, r + stroke / 2 + 3);
    extra += `<line class="tick" x1="${a0.toFixed(2)}" y1="${b0.toFixed(2)}" x2="${a1.toFixed(2)}" y2="${b1.toFixed(2)}"/>`;
  }
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="${stroke}" class="track" style="stroke:${color}"/>
    ${p > 0 ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="${stroke}" class="arc"
      style="stroke:${color};--len:${c.toFixed(2)};--c:${color}" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
      transform="rotate(-90 ${cx} ${cx})"/>` : ""}
    ${over > 0 ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="${stroke}" class="arc over"
      style="stroke:${color};--len:${c.toFixed(2)};--c:${color}" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - over)).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cx})"/>` : ""}
    ${extra}
  </svg>`;
}

/* ── sparkline ─────────────────────────────────────────────────────────── */

export function sparkline(values, { width = 220, height = 44, color = "#EDEDF2" } = {}) {
  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v != null);
  if (pts.length < 2) return "";
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const pad = 5;
  const x = (i) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v) => pad + (hi === lo ? 0.5 : (hi - v) / (hi - lo)) * (height - pad * 2);
  const d = pts.map((p, j) => `${j ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-opacity=".55" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>
  </svg>`;
}

/* ── weight line ───────────────────────────────────────────────────────── */

/**
 * Daily weigh-ins as small dots, the 7-day mean as the line that matters,
 * the goal as a quiet rule. Hover anywhere for the crosshair.
 */
export function weightChart(series, { width, height = 320, goal, start, fmtDay }) {
  const P = { l: 44, r: 70, t: 18, b: 30 };
  const W = Math.max(280, width);
  const vals = series.flatMap((s) => [s.v, s.avg]).filter((v) => v != null);
  if (!vals.length) return `<div class="nodata">No weigh-ins in this range yet.</div>`;
  let lo = Math.min(...vals, goal) - 1;
  let hi = Math.max(...vals) + 1;
  const step = niceStep(hi - lo, 7);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const iw = W - P.l - P.r, ih = height - P.t - P.b;
  const n = series.length;
  const x = (i) => P.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => P.t + ((hi - v) / (hi - lo)) * ih;

  let grid = "";
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="axis" x="${P.l - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 90))));
  let xl = "";
  series.forEach((s, i) => {
    if ((n - 1 - i) % every === 0) xl += `<text class="axis" x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(fmtDay(s.key, true))}</text>`;
  });

  const path = (acc) => {
    let d = "", pen = false;
    series.forEach((s, i) => {
      const v = acc(s);
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const avgD = path((s) => s.avg);
  const firstAvg = series.findIndex((s) => s.avg != null);
  let lastAvg = -1;
  series.forEach((s, i) => { if (s.avg != null) lastAvg = i; });
  const area = firstAvg >= 0
    ? `${avgD}L${x(lastAvg).toFixed(1)},${(P.t + ih).toFixed(1)}L${x(firstAvg).toFixed(1)},${(P.t + ih).toFixed(1)}Z`
    : "";

  const dots = series.map((s, i) => (s.v == null ? "" :
    `<circle class="wdot" cx="${x(i).toFixed(1)}" cy="${y(s.v).toFixed(1)}" r="2.6"/>`)).join("");

  const gy = y(goal);
  const goalRule = `<line class="goal" x1="${P.l}" x2="${W - P.r}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"/>
    <text class="goallab" x="${W - P.r + 8}" y="${(gy + 4).toFixed(1)}">Goal ${goal}</text>`;

  let startMark = "";
  if (start && series[0].v != null && Math.abs(series[0].v - start) < 0.05) {
    startMark = `<circle class="startdot" cx="${x(0)}" cy="${y(start).toFixed(1)}" r="4.5"/>
      <text class="startlab" x="${x(0) + 10}" y="${(y(start) - 8).toFixed(1)}">Start ${start}</text>`;
  }
  const endLab = lastAvg >= 0
    ? `<circle class="enddot" cx="${x(lastAvg).toFixed(1)}" cy="${y(series[lastAvg].avg).toFixed(1)}" r="5"/>
       <text class="endlab" x="${W - P.r + 8}" y="${(y(series[lastAvg].avg) + 5).toFixed(1)}">${series[lastAvg].avg.toFixed(1)}</text>`
    : "";

  const band = iw / Math.max(1, n - 1);
  const hits = series.map((s, i) => {
    const hx = x(i);
    const lines = [fmtDay(s.key), s.v != null ? `Weigh-in ${s.v.toFixed(1)} lb` : "No weigh-in", s.avg != null ? `7-day avg ${s.avg.toFixed(1)} lb` : ""];
    return `<g class="hit" ${tip(...lines)}>
      <rect x="${(hx - band / 2).toFixed(1)}" y="${P.t}" width="${Math.max(band, 2).toFixed(1)}" height="${ih}" fill="transparent"/>
      <line class="cross" x1="${hx.toFixed(1)}" x2="${hx.toFixed(1)}" y1="${P.t}" y2="${P.t + ih}"/>
      ${s.avg != null ? `<circle class="hdot" cx="${hx.toFixed(1)}" cy="${y(s.avg).toFixed(1)}" r="5"/>` : ""}
    </g>`;
  }).join("");

  return `<svg class="plot weight" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img"
      aria-label="Daily weight and 7-day average, goal ${goal} lb">
    <defs><linearGradient id="wfill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#EDEDF2" stop-opacity=".08"/><stop offset="1" stop-color="#EDEDF2" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}${xl}${goalRule}
    ${area ? `<path d="${area}" fill="url(#wfill)"/>` : ""}
    <path class="wline" d="${path((s) => s.v)}"/>
    ${dots}
    <path class="avgline" d="${avgD}"/>
    ${startMark}${endLab}${hits}
  </svg>`;
}

/* ── nutrition trend ───────────────────────────────────────────────────── */

/**
 * Each day as a dot against the target zone (calories) or target line, with a
 * trailing 7-day mean on top. The axis hugs the data rather than zero: intake
 * lives within ±15% of target, and a zero baseline would flatten exactly the
 * difference this chart exists to show. Off-target days are hollow, so the
 * read never depends on colour alone.
 */
export function trendChart(rows, { width, height = 280, color, target, zone, unit, fmtDay, fmtVal }) {
  const P = { l: 52, r: 18, t: 16, b: 30 };
  const W = Math.max(260, width);
  const iw = W - P.l - P.r, ih = height - P.t - P.b;
  const vals = rows.map((r) => r.v).filter((v) => v != null);
  if (!vals.length) return `<div class="nodata">Nothing logged in this range yet.</div>`;
  const refs = zone ? zone : [target];
  let lo = Math.min(...vals, ...refs), hi = Math.max(...vals, ...refs);
  const pad = Math.max((hi - lo) * 0.1, hi * 0.02);
  const step = niceStep(hi - lo + pad * 2, 5);
  lo = Math.max(0, Math.floor((lo - pad) / step) * step);
  hi = Math.ceil((hi + pad) / step) * step;
  const n = rows.length;
  const x = (i) => P.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => P.t + ((hi - v) / (hi - lo)) * ih;

  let grid = "";
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="axis" x="${P.l - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtVal(v, true))}</text>`;
  }
  const ref = zone
    ? `<rect class="zoneband" x="${P.l}" width="${iw}" y="${y(zone[1]).toFixed(1)}" height="${(y(zone[0]) - y(zone[1])).toFixed(1)}" style="fill:${color}"/>`
    : `<line class="target" x1="${P.l}" x2="${W - P.r}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/>`;

  // Partial food days are drawn, faintly, but never feed the average.
  const avg = rows.map((_, i) => {
    const win = rows.slice(Math.max(0, i - 6), i + 1).filter((r) => !r.partial).map((r) => r.v).filter((v) => v != null);
    return win.length >= 3 ? win.reduce((s, v) => s + v, 0) / win.length : null;
  });
  const path = (vs) => {
    let d = "", pen = false;
    vs.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  const band = n > 1 ? iw / (n - 1) : iw;
  const dotR = n > 45 ? 3 : 4.5;
  const hits = rows.map((row, i) => {
    const cx = x(i);
    const lab = (n - 1 - i) % every === 0
      ? `<text class="axis" x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(fmtDay(row.key, n > 10))}</text>` : "";
    const lines = [fmtDay(row.key), row.v != null ? `${fmtVal(row.v)} ${unit}${row.partial ? " so far" : ""}` : "No data",
      row.partial ? "Partial log — not in averages" : row.v != null ? (row.met ? "✓ On target" : "○ Off target") : "",
      avg[i] != null ? `7-day avg ${fmtVal(avg[i])} ${unit}` : ""];
    const dot = row.v == null ? "" : row.partial
      ? `<circle class="tdot part" cx="${cx.toFixed(1)}" cy="${y(row.v).toFixed(1)}" r="${dotR - 1.5}" style="stroke:${color}"/>`
      : row.met
      ? `<circle class="tdot" cx="${cx.toFixed(1)}" cy="${y(row.v).toFixed(1)}" r="${dotR}" style="fill:${color}"/>`
      : `<circle class="tdot off" cx="${cx.toFixed(1)}" cy="${y(row.v).toFixed(1)}" r="${dotR - 0.75}" style="stroke:${color}"/>`;
    return `<g class="hit" ${tip(...lines)}>
      <rect x="${(cx - band / 2).toFixed(1)}" y="${P.t}" width="${Math.max(band, 2).toFixed(1)}" height="${ih}" class="hitbg"/>
      <line class="cross" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${P.t}" y2="${P.t + ih}"/>
      ${dot}${lab}</g>`;
  }).join("");

  return `<svg class="plot trend" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img" aria-label="Daily intake against target">
    ${grid}${ref}
    <path class="tline" d="${path(rows.map((r) => (r.partial ? null : r.v)))}" style="stroke:${color}"/>
    <path class="tavg" d="${path(avg)}" style="stroke:${color};--c:${color}"/>
    ${hits}
  </svg>`;
}

/** Seven slim columns for the steps card, the goal as a rule. */
export function miniBars(rows, { color, target, fmtDay }) {
  const W = 224, H = 78, base = 60;
  const hi = Math.max(target * 1.25, ...rows.map((r) => r.v || 0));
  const bandW = W / rows.length, bw = 16;
  const y = (v) => base - (v / hi) * (base - 4);
  const bars = rows.map((r, i) => {
    const cx = bandW * (i + 0.5);
    const top = r.v ? y(r.v) : base;
    const h = base - top, rr = Math.min(4, h);
    const d = r.v ? `M${cx - bw / 2},${base}V${top + rr}Q${cx - bw / 2},${top} ${cx - bw / 2 + rr},${top}H${cx + bw / 2 - rr}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + rr}V${base}Z` : "";
    return `<g class="hit" ${tip(fmtDay(r.key), r.v != null ? `${r.v.toLocaleString("en-US")} steps` : "Not logged")}>
      <rect x="${cx - bandW / 2}" y="0" width="${bandW}" height="${H}" fill="transparent"/>
      ${d ? `<path class="col${r.v < target ? " off" : ""}" d="${d}" style="fill:${color}"/>` : ""}
      <text class="axis${r.today ? " on" : ""}" x="${cx}" y="${H - 2}" text-anchor="middle">${esc(fmtDay(r.key, "letter"))}</text>
    </g>`;
  }).join("");
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" aria-label="Steps, last seven days">
    <line class="target" x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}"/>${bars}</svg>`;
}

/* ── sleep timeline ────────────────────────────────────────────────────── */

/**
 * Each night as a bar from bedtime to wake on a shared 8pm→noon clock, so a
 * drifting bedtime is visible at a glance, not buried in an hours total.
 */
export function sleepTimeline(nights, { width, color, fmtDay, fmtDur, fmtClock, targetMins, target }) {
  const rowH = 34, P = { l: 74, r: 74, t: 30, b: 8 };
  const W = Math.max(300, width);
  const H = P.t + nights.length * rowH + P.b;
  const iw = W - P.l - P.r;
  const SPAN = 960; // 20:00 → 12:00
  const x = (off) => P.l + (clamp(off, 0, SPAN) / SPAN) * iw;
  const hours = [0, 120, 240, 360, 480, 600, 720, 840, 960];
  const labs = ["8p", "10p", "12a", "2a", "4a", "6a", "8a", "10a", "12p"];
  const narrow = iw < 420;
  let grid = hours.map((h, i) => `<line class="grid${h === 240 ? " mid" : ""}" x1="${x(h).toFixed(1)}" x2="${x(h).toFixed(1)}" y1="${P.t - 8}" y2="${H - P.b}"/>
    ${!narrow || i % 2 === 0 ? `<text class="axis" x="${x(h).toFixed(1)}" y="${P.t - 14}" text-anchor="middle">${labs[i]}</text>` : ""}`).join("");

  // The target window, drawn behind everything so on-schedule nights sit inside it.
  let band = "";
  if (target && target.bed != null && target.wake != null) {
    let tw = target.wake;
    if (tw <= target.bed) tw += 1440;
    const bx0 = x(target.bed), bx1 = x(tw);
    band = `<rect class="sleeptarget" x="${bx0.toFixed(1)}" y="${P.t - 4}" width="${(bx1 - bx0).toFixed(1)}" height="${(H - P.b - P.t + 4).toFixed(1)}" rx="10" style="fill:${color}"/>
      <text class="axis tgtlab" x="${((bx0 + bx1) / 2).toFixed(1)}" y="${H - P.b + 14}" text-anchor="middle">Target ${esc(fmtClock(target.bed))} – ${esc(fmtClock(target.wake))}</text>`;
  }
  const rows = nights.map((nt, i) => {
    const cy = P.t + i * rowH + rowH / 2;
    const label = `<text class="axis rowlab${nt.today ? " on" : ""}" x="${P.l - 12}" y="${cy + 4}" text-anchor="end">${esc(fmtDay(nt.key, "short"))}</text>`;
    if (nt.bed == null) {
      return `${label}<text class="axis nolog" x="${P.l + 8}" y="${cy + 4}">Not logged</text>`;
    }
    let wake = nt.wake;
    if (wake <= nt.bed) wake += 1440;
    const x0 = x(nt.bed), x1 = x(wake);
    const short = nt.mins < targetMins;
    return `<g class="hit" ${tip(fmtDay(nt.key), `${fmtClock(nt.bed)} → ${fmtClock(nt.wake)}`, `${fmtDur(nt.mins)} asleep`)}>
      <rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" class="hitbg"/>
      ${label}
      <rect class="sleepbar${short ? " short" : ""}" x="${x0.toFixed(1)}" y="${cy - 7}" width="${Math.max(6, x1 - x0).toFixed(1)}" height="14" rx="7" style="fill:${color};--c:${color}"/>
      <text class="axis dur" x="${W - P.r + 12}" y="${cy + 4}">${esc(fmtDur(nt.mins))}</text>
    </g>`;
  }).join("");

  const Ht = band ? H + 18 : H;
  return `<svg class="plot sleep" viewBox="0 0 ${W} ${Ht}" width="${W}" height="${Ht}" role="img" aria-label="Bedtime to wake, recent nights">
    ${band}${grid}${rows}</svg>`;
}

/* ── fitness ───────────────────────────────────────────────────────────── */

/**
 * Concentric rings, Apple-style but in this site's hand: outermost first.
 * Each ring is its own metric against its own goal.
 */
export function concentric(rings, { size = 220, stroke = 18, gap = 5 } = {}) {
  const cx = size / 2;
  const arcs = rings.map((r, i) => {
    const rad = cx - stroke / 2 - 2 - i * (stroke + gap);
    const c = 2 * Math.PI * rad;
    const p = clamp(r.pct || 0, 0, 1);
    const over = clamp((r.pct || 0) - 1, 0, 1);
    const arc = (frac, cls) => `<circle cx="${cx}" cy="${cx}" r="${rad.toFixed(2)}" fill="none" stroke-width="${stroke}" class="arc${cls}"
      style="stroke:${r.color};--len:${c.toFixed(2)};--c:${r.color};animation-delay:${i * 120}ms" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(2)}" transform="rotate(-90 ${cx} ${cx})"/>`;
    return `<circle cx="${cx}" cy="${cx}" r="${rad.toFixed(2)}" fill="none" stroke-width="${stroke}" class="track" style="stroke:${r.color}"/>
      ${p > 0 ? arc(p, "") : ""}${over > 0 ? arc(over, " over") : ""}`;
  }).join("");
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
    aria-label="${esc(rings.map((r) => `${r.label} ${Math.round((r.pct || 0) * 100)}%`).join(", "))}">${arcs}</svg>`;
}

/**
 * A week of workouts as blocks on a day × time-of-day grid: each block is
 * where the workout actually sat in the day, tall as it lasted, coloured
 * by type, labelled with type, minutes and calories when there's room.
 */
export function workoutWeek(keys, byDay, { width, typeColor, fmtDay, today }) {
  const P = { l: 40, r: 8, t: 36, b: 8 };
  const W = Math.max(300, width);
  // Zoom to the hours this week's workouts actually use (an hour either side, 6h at least),
  // so a 30-minute session is tall enough to carry its own label.
  let lo = Infinity, hi = -Infinity;
  for (const k of keys) for (const w of byDay[k] || []) {
    const s = minutesOf(w.start), e = s + (w.durationMin || 30);
    lo = Math.min(lo, Math.floor(s / 60) * 60 - 60);
    hi = Math.max(hi, Math.ceil(e / 60) * 60 + 60);
  }
  if (!Number.isFinite(lo)) { lo = 6 * 60; hi = 22 * 60; }
  if (hi - lo < 360) { const mid = (lo + hi) / 2; lo = Math.floor((mid - 180) / 60) * 60; hi = lo + 360; }
  lo = Math.max(0, lo); hi = Math.min(24 * 60, hi);
  const ppm = Math.min(2.2, Math.max(0.6, 420 / (hi - lo))); // pixels per minute
  const H = P.t + (hi - lo) * ppm + P.b;
  const colW = (W - P.l - P.r) / keys.length;
  const y = (m) => P.t + (m - lo) * ppm;
  let grid = "";
  const every = hi - lo > 720 ? 120 : 60;
  for (let m = lo; m <= hi; m += every) {
    const h = Math.floor(m / 60) % 24;
    grid += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(m).toFixed(1)}" y2="${y(m).toFixed(1)}"/>
      <text class="axis" x="${P.l - 8}" y="${(y(m) + 4).toFixed(1)}" text-anchor="end">${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}</text>`;
  }
  const heads = keys.map((k, i) => {
    const cx = P.l + colW * (i + 0.5);
    return `${i ? `<line class="grid" x1="${(P.l + colW * i).toFixed(1)}" x2="${(P.l + colW * i).toFixed(1)}" y1="${P.t - 6}" y2="${H - P.b}"/>` : ""}
      <text class="axis${k === today ? " on" : ""}" x="${cx.toFixed(1)}" y="${P.t - 16}" text-anchor="middle">${esc(fmtDay(k, "short"))}</text>`;
  }).join("");
  const blocks = keys.map((k, i) => (byDay[k] || []).map((w) => {
    const s = minutesOf(w.start), dur = w.durationMin || 30;
    const x0 = P.l + colW * i + 4, bw = colW - 8;
    const y0 = y(s), bh = Math.max(16, dur * ppm);
    const c = typeColor(w.type);
    const short = shortType(w.type);
    const meta = [w.durationMin != null ? `${Math.round(w.durationMin)}m` : null, w.kcal != null ? `${Math.round(w.kcal)} kcal` : null].filter(Boolean).join(" · ");
    const lines = [`${w.type}`, `${fmtDay(k)} · ${clock12(s)}–${clock12(s + dur)}`,
      w.durationMin != null ? `${Math.round(w.durationMin)} min` : "", w.kcal != null ? `${Math.round(w.kcal)} active kcal` : "",
      w.avgHR != null ? `Avg heart rate ${Math.round(w.avgHR)} bpm` : "",
      w.distance != null ? `${w.distance} ${w.distanceUnit || ""}`.trim() : ""];
    const label = bw > 54 && bh >= 30
      ? `<text class="wlab" x="${(x0 + 8).toFixed(1)}" y="${(y0 + 15).toFixed(1)}">${esc(short)}</text>
         ${bh >= 44 && meta ? `<text class="wmeta" x="${(x0 + 8).toFixed(1)}" y="${(y0 + 30).toFixed(1)}">${esc(meta)}</text>` : ""}`
      : "";
    return `<g class="hit wblock" ${tip(...lines)}>
      <rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="7" style="fill:${c};--c:${c}"/>
      <clipPath id="wc-${k}-${s}"><rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${bh.toFixed(1)}"/></clipPath>
      <g clip-path="url(#wc-${k}-${s})">${label}</g>
    </g>`;
  }).join("")).join("");
  return `<svg class="plot wweek" viewBox="0 0 ${W} ${H.toFixed(0)}" width="${W}" height="${H.toFixed(0)}" role="img" aria-label="Workouts this week by time of day">
    ${grid}${heads}${blocks}</svg>`;
}

const minutesOf = (stamp) => { const [h, m] = stamp.slice(11, 16).split(":").map(Number); return h * 60 + m; };
const clock12 = (m) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")}${h < 12 ? "a" : "p"}`; };
export function shortType(t) {
  return String(t).replace(/^Traditional /, "").replace(/^Functional /, "").replace(/High Intensity Interval Training/, "HIIT");
}

/** Exercise minutes per week against the weekly target, one column per week. */
export function weekBars(rows, { width, color, target, fmtLabel }) {
  const P = { l: 40, r: 10, t: 14, b: 26 };
  const W = Math.max(260, width), H = 170;
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const hi = Math.max(target * 1.2, ...rows.map((r) => r.v || 0)) || 1;
  const step = niceStep(hi, 3);
  const top = Math.ceil(hi / step) * step;
  const y = (v) => P.t + ih - (v / top) * ih;
  const band = iw / rows.length, bw = Math.min(24, band - 4);
  let grid = "";
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="axis" x="${P.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  const cols = rows.map((r, i) => {
    const cx = P.l + band * (i + 0.5);
    const lab = `<text class="axis${r.current ? " on" : ""}" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(fmtLabel(r, i))}</text>`;
    let bar = "";
    if (r.v != null && r.v > 0) {
      const t = y(r.v), x0 = cx - bw / 2, h = P.t + ih - t, rr = Math.min(4, h);
      bar = `<path class="col${r.v < target ? " off" : ""}" style="fill:${color}" d="M${x0.toFixed(1)},${P.t + ih}V${(t + rr).toFixed(1)}Q${x0.toFixed(1)},${t.toFixed(1)} ${(x0 + rr).toFixed(1)},${t.toFixed(1)}H${(x0 + bw - rr).toFixed(1)}Q${(x0 + bw).toFixed(1)},${t.toFixed(1)} ${(x0 + bw).toFixed(1)},${(t + rr).toFixed(1)}V${P.t + ih}Z"/>`;
    }
    return `<g class="hit" ${tip(r.title, r.v != null ? `${Math.round(r.v)} exercise min` : "No data", r.sub || "")}>
      <rect x="${(cx - band / 2).toFixed(1)}" y="${P.t}" width="${band.toFixed(1)}" height="${ih}" class="hitbg"/>${bar}${lab}</g>`;
  }).join("");
  return `<svg class="plot mini weekbars" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Exercise minutes per week">
    ${grid}${cols}<line class="target" x1="${P.l}" x2="${W - P.r}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/></svg>`;
}

/**
 * The week's calories, Monday → Sunday: complete days solid, partial days
 * outlined, days with nothing logged marked "—". A line marks the daily
 * target. Descriptive only — no colour for "good" or "bad".
 */
export function pacingChart(rows, { width, daily, color, fmtDay }) {
  const P = { l: 8, r: 8, t: 22, b: 30 };
  const W = Math.max(280, width), H = 168;
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const hi = Math.max(daily * 1.35, ...rows.map((r) => r.kcal || 0)) || 1;
  const y = (v) => P.t + ih - (v / hi) * ih;
  const band = iw / rows.length, bw = Math.min(40, band - 12);
  const cols = rows.map((r, i) => {
    const cx = P.l + band * (i + 0.5);
    const x0 = cx - bw / 2;
    const day = band >= 58 ? fmtDay(r.key, "short") : fmtDay(r.key, "short").split(" ")[0];
    const lab = `<text class="axis${r.isToday ? " on" : ""}" x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(day)}</text>`;
    let bar = "", val = "";
    if (r.kcal != null && r.kcal > 0) {
      const t = y(r.kcal), h = P.t + ih - t, rr = Math.min(6, h);
      const d = `M${x0.toFixed(1)},${P.t + ih}V${(t + rr).toFixed(1)}Q${x0.toFixed(1)},${t.toFixed(1)} ${(x0 + rr).toFixed(1)},${t.toFixed(1)}H${(x0 + bw - rr).toFixed(1)}Q${(x0 + bw).toFixed(1)},${t.toFixed(1)} ${(x0 + bw).toFixed(1)},${(t + rr).toFixed(1)}V${P.t + ih}Z`;
      bar = `<path class="pbar ${r.status}" d="${d}" style="--c:${color}"/>`;
      val = `<text class="pval${r.status === "complete" ? "" : " part"}" x="${cx.toFixed(1)}" y="${(t - 7).toFixed(1)}" text-anchor="middle">${Math.round(r.kcal).toLocaleString("en-US")}</text>`;
    } else if (!r.future) {
      val = `<text class="pval none" x="${cx.toFixed(1)}" y="${(P.t + ih - 8).toFixed(1)}" text-anchor="middle">—</text>`;
    } else {
      bar = `<rect class="pfuture" x="${x0.toFixed(1)}" y="${(P.t + ih - 4).toFixed(1)}" width="${bw.toFixed(1)}" height="4" rx="2"/>`;
    }
    const word = r.future ? "Upcoming" : r.status === "complete" ? "Complete log" : r.status === "partial" ? (r.isToday ? "In progress" : "Partial log") : "No data";
    return `<g class="hit" ${tip(fmtDay(r.key), r.kcal != null ? `${Math.round(r.kcal).toLocaleString("en-US")} kcal` : word, r.kcal != null ? word : "")}>
      <rect x="${(cx - band / 2).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="${H}" class="hitbg"/>${bar}${val}${lab}</g>`;
  }).join("");
  const ty = y(daily).toFixed(1);
  return `<svg class="plot pacing" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Calories each day this week against the daily target">
    <line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${P.t + ih}" y2="${P.t + ih}"/>
    <line class="target" x1="${P.l}" x2="${W - P.r}" y1="${ty}" y2="${ty}" stroke-dasharray="4 4"/>
    <text class="axis" x="${W - P.r}" y="${(Number(ty) - 6).toFixed(1)}" text-anchor="end">${Math.round(daily).toLocaleString("en-US")} daily target</text>
    ${cols}</svg>`;
}
