// Ash Health's web server. On Railway it reads its settings from Variables;
// locally, with none set, it runs open on http://localhost:5173 and keeps
// the log in data/local.json.
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./server/db.mjs";
import { createApp } from "./server/app.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);

let secret = env.SESSION_SECRET;
if (!secret) {
  secret = randomBytes(32).toString("hex");
  if (env.APP_PASSWORD) console.warn("[web] SESSION_SECRET is not set: sign-ins will reset on every restart.");
}
if (!env.APP_PASSWORD) {
  console.warn(onRailway
    ? "[web] APP_PASSWORD is not set: the site will refuse to serve until it is."
    : "[web] APP_PASSWORD is not set: running open for local use.");
}
if (!env.INGEST_TOKEN) console.warn("[web] INGEST_TOKEN is not set: Apple Health uploads are switched off.");

const store = await openStore({
  databaseUrl: env.DATABASE_URL,
  file: env.DATA_FILE || join(root, "data", "local.json"),
});
const app = createApp({
  store,
  root,
  password: env.APP_PASSWORD,
  secret,
  ingestToken: env.INGEST_TOKEN,
  requireAuth: onRailway,
});

const port = Number(env.PORT) || 5173;
app.listen(port, () => console.log(`[web] Ash Health on :${port} (${store.kind} storage)`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => app.close(() => store.close().finally(() => process.exit(0))));
}
