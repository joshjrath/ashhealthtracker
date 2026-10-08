// Ash Health's web server. On Railway it reads a few Variables; everything
// else — upload tokens, the password after first sign-in, dashboard
// defaults — is changed in the site's own Settings page. Locally, with
// nothing set, it runs open on http://localhost:5173 and keeps the log in
// data/local.json.
//
// Where the log lives decides whether it survives an update: see
// server/storage.mjs. Railway's own disk does not.
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./server/db.mjs";
import { createApp } from "./server/app.mjs";
import { pickStorage } from "./server/storage.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const storage = pickStorage(env, root);
const onRailway = storage.onRailway;

if (!storage.persistent) {
  console.error([
    "",
    "[web] ⚠ YOUR DATA IS ON RAILWAY'S TEMPORARY DISK — IT IS ERASED ON EVERY DEPLOY.",
    "[web]   Fix: add a PostgreSQL database to this project, then add the variable",
    "[web]   DATABASE_URL = ${{Postgres.DATABASE_URL}} to this service (or attach a volume).",
    "[web]   Export your data from Settings first; import it after the redeploy.",
    "",
  ].join("\n"));
}

const store = await openStore({ databaseUrl: storage.databaseUrl, file: storage.file });

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
  storage,
  version: env.RAILWAY_GIT_COMMIT_SHA || "",
  // Optional: food lookup keys can also be set in Settings → Food lookup.
  foodEnv: {
    usdaKey: env.USDA_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
    fatsecretId: env.FATSECRET_CLIENT_ID,
    fatsecretSecret: env.FATSECRET_CLIENT_SECRET,
  },
});

const auth = await store.getMeta("auth");
if (!env.APP_PASSWORD && !auth?.hash) {
  console.warn(onRailway
    ? "[web] No password yet: set APP_PASSWORD in Railway → Variables. The site stays closed until then."
    : "[web] No password set: running open for local use.");
}

const port = Number(env.PORT) || 5173;
app.listen(port, () => console.log(`[web] Ash Health on :${port} — data in ${storage.where}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => app.close(() => store.close().finally(() => process.exit(0))));
}
