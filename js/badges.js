/* ──────────────────────────────────────────────────────────────────────────
   Badge artwork, drawn as SVG so it stays crisp and themeable.

   Each family has its own colour and emblem; tiers add detail:
     I    a plain medallion
     II   a second ring
     III  a notched, engraved rim
     IV   laurels and a richer fill
     V    rays and a crown star — unmistakably the top tier
   Locked badges are the same art, desaturated and dim. How far you are
   toward a badge (0–1, `lit`) brings its colour back gradually, so a badge
   you're close to already looks close.
   ────────────────────────────────────────────────────────────────────────── */

export const THEMES = {
  weight: { color: "#F2A79C", deep: "#C96F62", name: "Weight Loss" },
  iron: { color: "#C3CEDB", deep: "#7F8C9C", name: "Iron" },
  training: { color: "#8EDB57", deep: "#4F9A26", name: "Training" },
  nutrition: { color: "#F3E96C", deep: "#B7A92A", name: "Nutrition" },
  complete: { color: "#9D8CF5", deep: "#6553C9", name: "Complete Days" },
};

const EMBLEMS = {
  // A line that steps down: weight coming off.
  weight: `<path d="M22 25l7 7 5-5 8 8" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M36.5 35.5h6v-6" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  // A dumbbell.
  iron: `<rect x="19" y="26" width="5" height="12" rx="1.6" fill="currentColor"/><rect x="40" y="26" width="5" height="12" rx="1.6" fill="currentColor"/><rect x="15.5" y="28.5" width="3.5" height="7" rx="1.2" fill="currentColor"/><rect x="45" y="28.5" width="3.5" height="7" rx="1.2" fill="currentColor"/><rect x="24" y="30.5" width="16" height="3" rx="1.2" fill="currentColor"/>`,
  // A calendar with a check.
  training: `<rect x="21" y="22" width="22" height="21" rx="4" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M21 28.5h22M27 19.5v5M37 19.5v5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M26.5 35.2l3.6 3.4 7.4-7.6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  // A leaf.
  nutrition: `<path d="M21.5 42.5c0-12 7.5-20 21.5-21-0.5 13.5-8.5 21-21.5 21z" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round"/><path d="M22.5 41.5c4.5-6 9-10 15-13.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`,
  // A star in a check.
  complete: `<path d="M32 19.5l3.7 7.6 8.3 1.2-6 5.9 1.4 8.3L32 38.6l-7.4 3.9 1.4-8.3-6-5.9 8.3-1.2z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>`,
};

let n = 0;
const attr = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

/** A notched (gear-like) rim for tiers III+. */
function notchedRim(r1, r2, teeth) {
  let d = "";
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const [x, y] = polar(32, 32, i % 2 ? r2 : r1, a);
    d += `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  return `${d}Z`;
}

/** Laurel sprigs curving up either side (tier IV+). */
function laurels(color) {
  let leaves = "";
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const a = Math.PI / 2 + side * (0.5 + i * 0.36);
      const [x, y] = polar(32, 33, 27.5, a);
      const rot = (a * 180) / Math.PI + (side > 0 ? -60 : 60);
      leaves += `<ellipse cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" rx="3.1" ry="1.5" transform="rotate(${rot.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})" fill="${color}"/>`;
    }
  }
  return leaves;
}

/** Rays behind the medallion (tier V). */
function rays(color) {
  let out = "";
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const [x1, y1] = polar(32, 32, 26, a);
    const [x2, y2] = polar(32, 32, i % 2 ? 29 : 31.5, a);
    out += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>`;
  }
  return out;
}

/**
 * badge({ theme, tier: 1–5, lit: 0–1, unlocked, size })
 * Returns an inline SVG string. `lit` is ignored once unlocked.
 */
export function badge({ theme = "complete", tier = 1, lit = 0, unlocked = false, size = 64, title = "" } = {}) {
  const t = THEMES[theme] || THEMES.complete;
  const id = `bd${(n += 1)}`;
  const c = t.color, deep = t.deep;
  const level = unlocked ? 1 : Math.max(0, Math.min(1, lit));
  const parts = [];
  parts.push(`<defs>
    <radialGradient id="${id}f" cx="38%" cy="30%" r="80%">
      <stop offset="0" stop-color="${c}" stop-opacity="${tier >= 4 ? 0.55 : 0.32}"/>
      <stop offset="1" stop-color="${deep}" stop-opacity="${tier >= 4 ? 0.28 : 0.12}"/>
    </radialGradient>
  </defs>`);
  if (tier >= 5) parts.push(rays(c));
  if (tier >= 3) parts.push(`<path d="${notchedRim(24.5, 26.5, tier >= 5 ? 20 : 16)}" fill="${deep}" fill-opacity="0.35" stroke="${c}" stroke-width="1.2" stroke-opacity="0.8"/>`);
  if (tier >= 4) parts.push(laurels(c));
  parts.push(`<circle cx="32" cy="32" r="20.5" fill="url(#${id}f)" stroke="${c}" stroke-width="2.2"/>`);
  if (tier >= 2) parts.push(`<circle cx="32" cy="32" r="${tier >= 3 ? 23 : 24}" fill="none" stroke="${c}" stroke-width="1.3" stroke-opacity="0.75"/>`);
  if (tier >= 3) parts.push(`<circle cx="32" cy="32" r="17.2" fill="none" stroke="${c}" stroke-width="0.8" stroke-opacity="0.55" stroke-dasharray="1.4 2.2"/>`);
  parts.push(`<g style="color:${c}">${EMBLEMS[theme] || EMBLEMS.complete}</g>`);
  if (tier >= 5) parts.push(`<path d="M32 1.8l2.3 4.4 4.9.7-3.6 3.4.9 4.8L32 12.8l-4.5 2.3.9-4.8-3.6-3.4 4.9-.7z" fill="${c}" stroke="#101012" stroke-width="0.8"/>`);
  // Tier plate
  const label = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][tier - 1] || String(tier);
  const w = 9 + label.length * 4.4;
  parts.push(`<rect x="${(32 - w / 2).toFixed(1)}" y="50" width="${w.toFixed(1)}" height="10" rx="5" fill="${tier >= 4 ? c : "#18181C"}" stroke="${c}" stroke-width="1.1"/>
    <text x="32" y="57.6" text-anchor="middle" font-family="var(--display), ui-sans-serif, system-ui" font-size="7" font-weight="800" fill="${tier >= 4 ? "#101012" : c}">${label}</text>`);
  const cls = unlocked ? "badge unlocked" : "badge locked";
  return `<svg class="${cls} t${tier}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${attr(title)}"
    style="--lit:${level.toFixed(2)};--c:${c}">${parts.join("")}</svg>`;
}
