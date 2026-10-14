/* ──────────────────────────────────────────────────────────────────────────
   The Google Sheet backup's script.

   Settings → Backups hands you this with your site's address and a backup
   link already filled in; you paste it into the sheet's Apps Script once.
   From then on, every night, the sheet:

     · fetches your whole log from the site (the link can only read)
     · writes readable tabs: Days, Food diary, Lifts, Workouts, My foods,
       Meals, Settings
     · keeps the full backup of each of the last 7 days in hidden tabs

   and its Ash Health → Restore menu puts any of those backups back on the
   site, after asking for the site's password. A failed night changes
   nothing, and the site refuses to send an empty log, so a good copy is
   never replaced by nothing.

   Apps Script runs on Google's servers (V8), not in this page — this file
   only builds its text.
   ────────────────────────────────────────────────────────────────────────── */

/** The script, ready to paste. */
export function sheetScript({ site, link }) {
  return `/**
 * Ash Health → this Google Sheet, every night.
 *
 * Set up once: paste this into Extensions → Apps Script, save, pick "setup"
 * in the toolbar and press Run, then allow access. After that it runs by
 * itself around 3am, and the Ash Health menu in the sheet has
 * "Back up now" and "Restore a backup to the website".
 *
 * Anyone who can edit this sheet can read the link below, which can download
 * your log — share the sheet only with people you'd trust with it.
 */
const SITE = ${JSON.stringify(site)};
const LINK = ${JSON.stringify(link)};
const KEEP = 7; // full backups kept, one per day
const CHUNK = 40000; // characters per cell (Google allows 50,000)
const PREFIX = "Backup ";
const TABS = ["Days", "Food diary", "Lifts", "Workouts", "My foods", "Meals", "Settings"];

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Ash Health")
    .addItem("Back up now", "backupNow")
    .addItem("Restore a backup to the website…", "restoreToSite")
    .addSeparator()
    .addItem("Turn on nightly backups", "setup")
    .addToUi();
}

/** Run once: turns on the nightly backup and makes the first one. */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "backupNow")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("backupNow").timeBased().everyDays(1).atHour(3).create();
  backupNow();
  try { onOpen(); } catch (e) { /* the menu appears next time the sheet opens */ }
}

/** Fetch the log and update the sheet. A failure changes nothing but the status line. */
function backupNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let res;
  try {
    res = UrlFetchApp.fetch(SITE + "/api/backup.json?sheet=1", { headers: { Authorization: "Bearer " + LINK }, muteHttpExceptions: true });
  } catch (e) {
    status(ss, "Couldn't reach the site (" + e.message + "). Nothing in this sheet was changed.", false);
    return;
  }
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
  if (res.getResponseCode() !== 200 || !body || !body.backup || !body.tables) {
    const why = body && body.error ? body.error : "The site answered " + res.getResponseCode();
    status(ss, why + ". Nothing in this sheet was changed.", false);
    return;
  }
  saveBackup(ss, body.backup, body.takenAt); // the full copy first
  TABS.forEach((name) => { if (body.tables[name]) writeTable(ss, name, body.tables[name]); });
  const s = body.summary || {};
  status(ss, "Backed up " + (s.days || 0) + " days, " + (s.entries || 0) + " diary entries, " + (s.foods || 0) + " saved foods.", true);
}

function writeTable(ss, name, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  if (!rows.length) return;
  const width = rows[0].length;
  const data = rows.map((r) => { const x = r.slice(0, width); while (x.length < width) x.push(""); return x; });
  sh.getRange(1, 1, data.length, width).setValues(data);
  sh.getRange(1, 1, 1, width).setFontWeight("bold");
  sh.setFrozenRows(1);
}

function backupTabs(ss) {
  return ss.getSheets()
    .filter((s) => s.getName().indexOf(PREFIX) === 0)
    .sort((a, b) => b.getName().localeCompare(a.getName())); // newest first
}

/** The full backup, as text split across cells (each starts with ~ so nothing reads it as a number or formula). */
function saveBackup(ss, backup, takenAt) {
  const name = PREFIX + String(takenAt).slice(0, 10);
  const sh = ss.getSheetByName(name) || ss.insertSheet(name, ss.getSheets().length);
  sh.clear();
  const text = JSON.stringify(backup);
  const rows = [["Full backup from " + takenAt + ". Used by Ash Health → Restore — don't edit this tab."]];
  for (let i = 0; i < text.length; i += CHUNK) rows.push(["~" + text.slice(i, i + CHUNK)]);
  const range = sh.getRange(1, 1, rows.length, 1);
  range.setNumberFormat("@");
  range.setValues(rows);
  sh.hideSheet();
  backupTabs(ss).slice(KEEP).forEach((s) => ss.deleteSheet(s));
}

function readBackup(sh) {
  const n = sh.getLastRow();
  if (n < 2) return "";
  return sh.getRange(2, 1, n - 1, 1).getValues()
    .map((r) => String(r[0]))
    .filter((v) => v.charAt(0) === "~")
    .map((v) => v.slice(1))
    .join("");
}

/** Put one of the kept backups back on the site. Needs the site's password. */
function restoreToSite() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = backupTabs(ss);
  if (!tabs.length) { ui.alert("There are no backups in this sheet yet. Use Ash Health → Back up now first."); return; }
  const dates = tabs.map((s) => s.getName().slice(PREFIX.length));
  const pick = ui.prompt("Restore to the website",
    "Which day's backup? Leave this empty for the newest (" + dates[0] + ").\\n\\nKept: " + dates.join(", "), ui.ButtonSet.OK_CANCEL);
  if (pick.getSelectedButton() !== ui.Button.OK) return;
  const want = pick.getResponseText().trim() || dates[0];
  const i = dates.indexOf(want);
  if (i < 0) { ui.alert("There's no backup from " + want + ". Kept: " + dates.join(", ")); return; }
  let backup;
  try { backup = JSON.parse(readBackup(tabs[i])); } catch (e) { ui.alert("The backup from " + want + " can't be read. Try another day."); return; }
  const days = Object.keys(backup.days || {}).length;
  const pw = ui.prompt("Website password",
    "This replaces everything on " + SITE + " with the backup from " + want + " (" + days + " days).\\n" +
    "What's on the site now is backed up there first, so this can be undone in Settings → Backups & rollback.\\n\\n" +
    "Type the password you sign in to the site with:", ui.ButtonSet.OK_CANCEL);
  if (pw.getSelectedButton() !== ui.Button.OK) return;
  let res;
  try {
    res = UrlFetchApp.fetch(SITE + "/api/restore", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      payload: JSON.stringify({ password: pw.getResponseText(), backup: backup, link: LINK }),
    });
  } catch (e) {
    ui.alert("Couldn't reach " + SITE + " (" + e.message + "). If the site moved, put its new address in SITE at the top of the script.");
    return;
  }
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
  if (res.getResponseCode() === 200 && body && body.ok) {
    ui.alert("Done — " + body.days + " days and " + body.items + " saved foods, meals and rewards are back on the site. Reload the site to see them.");
  } else {
    ui.alert("The site didn't accept it: " + (body && body.error ? body.error : "it answered " + res.getResponseCode()));
  }
}

/** The About tab: when it last worked, and how to restore. */
function status(ss, message, ok) {
  let sh = ss.getSheetByName("About");
  if (!sh) {
    const blank = ss.getSheetByName("Sheet1");
    if (blank && blank.getLastRow() === 0) { blank.setName("About"); sh = blank; } else sh = ss.insertSheet("About", 0);
  }
  const now = new Date();
  const props = PropertiesService.getScriptProperties();
  if (ok) props.setProperty("lastOk", now.toISOString());
  const lastOk = props.getProperty("lastOk");
  const kept = backupTabs(ss).map((s) => s.getName().slice(PREFIX.length)).join(", ") || "none yet";
  const rows = [
    ["Ash Health backup", ""],
    ["", ""],
    ["Last good backup", lastOk ? new Date(lastOk) : "Not yet"],
    ["Last run", now],
    ["Result", (ok ? "✓ " : "✗ ") + message],
    ["Full backups kept", kept],
    ["Site", SITE],
    ["", ""],
    ["Restore", "Ash Health menu → Restore a backup to the website… You'll need the site's password. The site saves what it has first, so a restore can be undone in Settings → Backups & rollback."],
    ["Tabs", "Days · Food diary · Lifts · Workouts · My foods · Meals · Settings are for reading. They're rewritten every night, so edits there don't change the site."],
    ["Runs", "Every night around 3am, and whenever you choose Ash Health → Back up now."],
  ];
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1).setFontWeight("bold").setFontSize(14);
  sh.getRange(3, 1, rows.length - 2, 1).setFontWeight("bold");
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 640);
  sh.getRange(3, 2, rows.length - 2, 1).setWrap(true);
}
`;
}
