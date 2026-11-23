/* ──────────────────────────────────────────────────────────────────────────
   Notifications on the page: the Notifications page the bell opens, and
   Settings → Notifications. What gets sent, and when, is decided on the
   server (server/notify.mjs); this only shows it and saves your choices.
   ────────────────────────────────────────────────────────────────────────── */
import { esc } from "./charts.js";
import { ago } from "./metrics.js";

const PRIORITY = {
  critical: { word: "Critical", cls: "crit" },
  important: { word: "Important", cls: "imp" },
  info: { word: "Update", cls: "info" },
  reminder: { word: "Reminder", cls: "rem" },
};
const MODE_LABEL = { on: "Right away", daily: "Daily digest", weekly: "Weekly digest", off: "Off" };
const CAT_ICON = {
  nutrition: "M5 4v5a2 2 0 0 0 4 0V4M7 9v7M14 4c-1.6 1-2 3-2 5h2v7",
  weight: "M3 6l4.5 5 3-3L17 14",
  fitness: "M3 8v4M17 8v4M5.5 6v8M14.5 6v8M5.5 10h9",
  recovery: "M13.5 3.5a6.8 6.8 0 1 0 3 9.8 5.4 5.4 0 0 1-3-9.8z",
  insights: "M10 3a5 5 0 0 1 3 9v2H7v-2a5 5 0 0 1 3-9zM8 17h4",
  achievements: "M6 3.5h8v4a4 4 0 0 1-8 0zM10 11.5v3M7 16.5h6",
  phases: "M3 14l4-4 3 3 7-7M13 6h4v4",
  system: "M10 2.8l6 2.4v4.6c0 3.6-2.5 6.3-6 7.4-3.5-1.1-6-3.8-6-7.4V5.2z",
};
const icon = (cat) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${CAT_ICON[cat] || CAT_ICON.insights}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const dayHead = (iso) => {
  const d = new Date(iso), t = new Date();
  const k = (x) => x.toDateString();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  return k(d) === k(t) ? "Today" : k(d) === k(y) ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
};

export function notificationsPage(ctx) {
  const n = ctx.state.notifs || { items: [], unread: 0, held: 0 };
  const cats = ctx.state.notifySettings?.categories || {};
  const f = ctx.ui.notifFilter || "all";
  const fresh = ctx.ui.notifFresh || new Set();
  const list = n.items.filter((i) => f === "all" || (f === "unread" ? fresh.has(i.id) || !i.readAt : i.category === f));
  const usedCats = [...new Set(n.items.map((i) => i.category))];
  const chips = [["all", "All"], ["unread", "New"], ...usedCats.map((c) => [c, cats[c] || c])]
    .map(([v, l]) => `<button type="button" class="tab${v === f ? " on" : ""}" data-act="notif-filter" data-v="${esc(v)}">${esc(l)}</button>`).join("");
  let lastHead = "";
  const rows = list.map((i) => {
    const head = dayHead(i.createdAt);
    const h = head !== lastHead ? `<div class="sec-l nf-day">${esc(head)}</div>` : "";
    lastHead = head;
    const p = PRIORITY[i.priority] || PRIORITY.info;
    const isNew = fresh.has(i.id) || !i.readAt;
    return `${h}<div class="nf ${p.cls}${isNew ? " unseen" : ""}">
      <span class="nf-ic">${icon(i.category)}</span>
      <div class="nf-main">
        <div class="nf-top"><b>${esc(i.title)}</b>${isNew ? `<span class="nf-dot" aria-label="New"></span>` : ""}</div>
        ${i.body ? `<p>${esc(i.body).replace(/\n/g, "<br>")}</p>` : ""}
        <div class="nf-meta"><span class="nf-pri">${p.word}</span><span>${esc(cats[i.category] || i.category)}</span><span>${esc(ago(new Date(i.createdAt)))}</span>
          ${i.link && i.link !== "#/notifications" ? `<a class="linkbtn quiet" href="${esc(i.link)}" data-act="notif-open" data-v="${esc(i.id)}">Open</a>` : ""}</div>
      </div>
      <button type="button" class="ib" data-act="notif-dismiss" data-v="${esc(i.id)}" title="Dismiss" aria-label="Dismiss">×</button>
    </div>`;
  }).join("");
  return `<section class="card notifs">
    <div class="cardhead"><h2>Notifications <span class="sub">${n.unread ? `${n.unread} new` : "all caught up"}${n.held ? ` · ${n.held} waiting for your digest` : ""}</span></h2>
      <div class="actions">
        <button type="button" class="btn" data-act="notif-check">Check now</button>
        ${n.items.some((i) => i.readAt) ? `<button type="button" class="btn" data-act="notif-clear">Clear read</button>` : ""}
        ${n.items.length ? `<button type="button" class="btn" data-act="notif-clear-all">Dismiss all</button>` : ""}
      </div></div>
    <div class="tabs nf-tabs">${chips}</div>
    <div class="nflist">${rows || `<div class="nodata">${f === "all" ? "Nothing yet. Notifications appear here when something meaningful happens — a new best, a sustained trend, a reminder you turned on." : "Nothing in this filter."}</div>`}</div>
    <p class="hint small">Shown here first, and on this device's notifications too if you turned them on in <a href="#/settings" data-jump="sec-notifications">Settings → Notifications</a>. Trends are only reported once they've held for days or weeks — never from a single weigh-in or meal.</p>
  </section>`;
}

/** Settings → Notifications. */
export function notificationsSection(ctx, secHead) {
  const ns = ctx.state.notifySettings;
  if (!ns) return "";
  const s = ns.settings;
  const cats = Object.entries(ns.categories).map(([c, label]) => `<label class="field"><span>${esc(label)}</span><span class="inp"><select name="cat-${c}">${Object.entries(MODE_LABEL).map(([m, l]) =>
    `<option value="${m}"${s.categories[c] === m ? " selected" : ""}${c === "system" && m === "off" ? " disabled" : ""}>${l}</option>`).join("")}</select></span></label>`).join("");
  const rem = (k, label, extra) => `<div class="nrem">
      <label class="chk"><input type="checkbox" name="rem-${k}"${s.reminders[k].on ? " checked" : ""}><i style="--c:#F3E96C"></i>${label}</label>
      ${extra}
    </div>`;
  const time = (k) => `<span class="inp"><input type="time" name="remt-${k}" value="${esc(s.reminders[k].time)}" aria-label="Time"></span>`;
  const here = ctx.ui.pushHere; // "on" · "off" · "unsupported" · "denied" · undefined (checking)
  const devices = ns.push.devices || [];
  const pushRow = here === "unsupported"
    ? `<p class="hint small">This browser can't receive push notifications. On iPhone, they only work after <b>Share → Add to Home Screen</b> (iOS 16.4+), opened from the home screen.</p>`
    : here === "denied"
      ? `<p class="hint small">Notifications are blocked for this site in your browser's settings — allow them there, then come back.</p>`
      : `<div class="actions">${here === "on"
        ? `<button type="button" class="btn" data-act="push-test">Send a test</button><button type="button" class="btn danger ghost" data-act="push-off">Turn off on this device</button>`
        : `<button type="button" class="btn primary" data-act="push-on">Turn on for this device</button>`}</div>`;
  return `<form class="card sc" id="sec-notifications" data-form="notify">
    ${secHead("notifications", "What's worth telling you, and how. Everything shows in the bell; reminders are off until you turn them on.")}
    <h3>By topic</h3>
    <div class="fields">${cats}</div>
    <p class="hint small">A digest bundles that topic into one note at your digest time. Security and data problems can't be turned off.</p>
    <h3>Reminders <span class="sub">they skip themselves once you've done the thing</span></h3>
    <div class="nrems">
      ${rem("meal", "Log meals, if nothing's logged by", time("meal"))}
      ${rem("weighIn", "Weigh in, if not done by", time("weighIn"))}
      ${rem("workout", "Today's planned workout (or rest day), at", time("workout"))}
      ${rem("bedtime", "Bedtime, before your target by", `<span class="inp"><select name="remb-bedtime">${[15, 30, 45, 60].map((m) => `<option value="${m}"${s.reminders.bedtime.before === m ? " selected" : ""}>${m} min</option>`).join("")}</select></span>`)}
    </div>
    <p class="hint small">The weigh-in reminder only comes if you've weighed in a few times recently, so it never nags a habit you don't have.</p>
    <h3>Timing</h3>
    <div class="fields">
      <label class="field"><span>Quiet hours from</span><span class="inp"><input type="time" name="quietFrom" value="${esc(s.quiet.from)}"></span></label>
      <label class="field"><span>Quiet hours until</span><span class="inp"><input type="time" name="quietTo" value="${esc(s.quiet.to)}"></span></label>
      <label class="field"><span>Digest time</span><span class="inp"><input type="time" name="digestTime" value="${esc(s.digestTime)}"></span></label>
      <label class="field"><span>Most per day</span><span class="inp"><select name="maxPerDay">${[[3, "3"], [6, "6"], [10, "10"], [99, "No limit"]].map(([v, l]) => `<option value="${v}"${s.maxPerDay === v ? " selected" : ""}>${l}</option>`).join("")}</select></span></label>
      <label class="field"><span>Time zone</span><span class="inp"><input name="tz" value="${esc(s.timeZone || "")}" readonly aria-readonly="true"></span></label>
    </div>
    <label class="chk"><input type="checkbox" name="quiet"${s.quiet.on ? " checked" : ""}><i style="--c:#9D8CF5"></i>Keep quiet hours</label>
    <p class="hint small">Past the daily limit, the rest wait for your digest. Reminders don't fire in quiet hours; other device notifications wait until quiet hours end, except critical ones.</p>
    <h3>Delivery</h3>
    <div class="ndeliv">
      <div><b>In the site</b><span>Always on — the bell in the sidebar.</span></div>
      <div><b>This device</b><span>${here === "on" ? "On — notifications show even when the site isn't open (as long as the browser is running)." : "Off."} ${devices.length ? `${devices.length} device${devices.length === 1 ? "" : "s"} signed up.` : ""}</span>${pushRow}</div>
      <div><b>Email</b><span>Not available — this server has no email service set up, so nothing is ever emailed.</span></div>
    </div>
    <label class="chk"><input type="checkbox" name="push"${s.push ? " checked" : ""}><i style="--c:#62D6C4"></i>Send to devices that turned notifications on</label>
    <div class="actions"><button class="btn primary" type="submit">Save notification settings</button><span class="saved" data-saved hidden></span></div>
  </form>`;
}

/** Read the Settings form back into the shape the server expects. */
export function readNotifyForm(f, base) {
  const s = structuredClone(base);
  for (const c of Object.keys(s.categories)) if (f.elements[`cat-${c}`]) s.categories[c] = f.elements[`cat-${c}`].value;
  for (const k of Object.keys(s.reminders)) {
    if (f.elements[`rem-${k}`]) s.reminders[k].on = f.elements[`rem-${k}`].checked;
    if (f.elements[`remt-${k}`]) s.reminders[k].time = f.elements[`remt-${k}`].value || s.reminders[k].time;
    if (f.elements[`remb-${k}`]) s.reminders[k].before = Number(f.elements[`remb-${k}`].value);
  }
  s.quiet = { on: f.elements.quiet.checked, from: f.elements.quietFrom.value || s.quiet.from, to: f.elements.quietTo.value || s.quiet.to };
  s.digestTime = f.elements.digestTime.value || s.digestTime;
  s.maxPerDay = Number(f.elements.maxPerDay.value);
  s.push = f.elements.push.checked;
  return s;
}

/** The VAPID key as the bytes PushManager.subscribe wants. */
export function keyBytes(b64u) {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
