import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import { SyncStore } from "../src/sync-store";
import type { WishlistItem, WishlistSnapshot } from "../src/types";

const config = loadConfig();
const databaseArgIndex = process.argv.indexOf("--database");
const databasePath =
  databaseArgIndex >= 0
    ? process.argv[databaseArgIndex + 1]
    : (process.env.BCTS_DATABASE ?? config.storage.database);
if (!databasePath) throw new Error("--database requires a path.");
const inputPath =
  process.env.BCTS_WISHLIST_SNAPSHOT ?? artifact("wishlist.json");
const mode =
  process.argv.includes("--full-rescan") || process.argv.includes("--full")
    ? "full"
    : "incremental";

if (!existsSync(inputPath))
  throw new Error(`Wishlist snapshot not found: ${inputPath}`);
const raw = JSON.parse(readFileSync(inputPath, "utf8")) as
  | WishlistSnapshot
  | WishlistItem[];
const items = Array.isArray(raw) ? raw : raw.items;
if (!Array.isArray(items))
  throw new Error("Wishlist snapshot items must be an array.");
const fanId = Array.isArray(raw)
  ? Number(process.env.BCTS_FAN_ID ?? 0)
  : raw.fanId;
if (!fanId)
  throw new Error(
    "A numeric fan id is required in the snapshot or BCTS_FAN_ID.",
  );

mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
const store = new SyncStore(database);
const runId = store.startRun(mode);
const summary = store.reconcileWishlist(fanId, items, new Date().toISOString());
const matchesPath = process.env.BCTS_MATCHES ?? artifact("tidal-matches.json");
if (existsSync(matchesPath))
  store.importMatches(
    JSON.parse(readFileSync(matchesPath, "utf8")) as Array<
      Record<string, unknown>
    >,
  );
const libraryPath = process.env.BCTS_LIBRARY ?? artifact("tidal-library.json");
if (existsSync(libraryPath))
  store.importLibrarySnapshot(
    JSON.parse(readFileSync(libraryPath, "utf8")) as Array<
      Record<string, unknown>
    >,
  );
const resultsPath =
  process.env.BCTS_WRITE_RESULTS ??
  artifact("tidal-add-remaining-results.json");
if (existsSync(resultsPath)) {
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as {
    batches?: Array<Record<string, unknown>>;
  };
  if (Array.isArray(results.batches))
    store.importWriteResults(runId, results.batches);
}
store.finishRun(runId, "completed");
const state = store.summary();
database.close();

if (process.env.BCTS_PIPELINE !== "1")
  console.log(
    JSON.stringify({ run_id: runId, mode, ...summary, state }, null, 2),
  );

function artifact(name: string): string {
  const configured = join(config.storage.output_dir, name);
  return existsSync(configured) ? configured : join("./output", name);
}
