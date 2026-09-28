// Ash Health's web server. On Railway it reads a few Variables; everything
// else — upload tokens, the password after first sign-in, dashboard
// defaults — is changed in the site's own Settings page. Locally, with
// nothing set, it runs open on http://localhost:5173 and keeps the log in
// data/local.json.
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./server/db.mjs";
import { createApp } from "./server/app.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);

const store = await openStore({
  databaseUrl: env.DATABASE_URL,
  file: env.DATA_FILE || join(root, "data", "local.json"),
});

// Sessions are signed with SESSION_SECRET if set, otherwise with a secret
// made once and kept in the database, so sign-ins survive restarts.
let secret = env.SESSION_SECRET || (await store.getMeta("sessionSecret"));
if (!secret) {
  secret = randomBytes(32).toString("hex");
  await store.setMeta("sessionSecret", secret);
}

// Locked out? Set PASSWORD_RESET=1 on Railway and redeploy: the password
// set in Settings is dropped and APP_PASSWORD works again. Then remove it.
if (env.PASSWORD_RESET === "1") {
  const auth = (await store.getMeta("auth")) || {};
  await store.setMeta("auth", { epoch: (auth.epoch ?? 0) + 1 });
  console.warn("[web] PASSWORD_RESET=1: the Settings password was cleared; sign in with APP_PASSWORD, then remove PASSWORD_RESET.");
}

const app = await createApp({
  store,
  root,
  password: env.APP_PASSWORD,
  secret,
  ingestToken: env.INGEST_TOKEN,
  requireAuth: onRailway,
});

const auth = await store.getMeta("auth");
if (!env.APP_PASSWORD && !auth?.hash) {
  console.warn(onRailway
    ? "[web] No password yet: set APP_PASSWORD in Railway → Variables. The site stays closed until then."
    : "[web] No password set: running open for local use.");
}

const port = Number(env.PORT) || 5173;
app.listen(port, () => console.log(`[web] Ash Health on :${port} (${store.kind} storage)`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => app.close(() => store.close().finally(() => process.exit(0))));
}
