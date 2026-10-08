/* ──────────────────────────────────────────────────────────────────────────
   Where the log lives, and whether it survives an update.

   On Railway, a service's own disk is replaced on every deploy: anything
   written there is gone after the next update. Only a database or an
   attached volume survives. So:

     DATABASE_URL (or Railway's other Postgres names)  → Postgres   · survives
     a Railway volume (RAILWAY_VOLUME_MOUNT_PATH)      → file there · survives
     your own computer                                 → data/local.json · survives
     Railway with neither                              → temporary  · ERASED ON UPDATE

   The last case still runs (the site shouldn't vanish), but it's reported
   as temporary everywhere: the server log, every page, and Settings.
   ────────────────────────────────────────────────────────────────────────── */
import { join, resolve } from "node:path";

export function pickStorage(env, root) {
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  const databaseUrl = env.DATABASE_URL || env.DATABASE_PRIVATE_URL || env.POSTGRES_URL || env.DATABASE_PUBLIC_URL || "";
  if (databaseUrl) {
    return { kind: "postgres", databaseUrl, persistent: true, onRailway, where: onRailway ? "Postgres database on Railway" : "Postgres database" };
  }
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || "";
  const file = resolve(env.DATA_FILE || (volume ? join(volume, "ash-health.json") : join(root, "data", "local.json")));
  if (!onRailway) return { kind: "file", file, persistent: true, onRailway, where: file };
  const onVolume = !!volume && (file === resolve(volume) || file.startsWith(resolve(volume) + "/"));
  return onVolume
    ? { kind: "file", file, persistent: true, onRailway, where: `Railway volume (${file})` }
    : { kind: "file", file, persistent: false, onRailway, where: "Railway's temporary disk — erased on every update" };
}
