import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createBatches,
  idempotencyKeyForBatch,
  successfulIds,
} from "./src/batches";
import { loadConfig } from "./src/config";
import { request } from "./src/http";
import { SyncStore } from "./src/sync-store";
import { classifyWriteOutcome, shouldRefreshToken } from "./src/write-policy";

const tokenPath = "./output/tidal-tokens.json";
const manifestPath = "./output/tidal-add-remaining.json";
const resultsPath = "./output/tidal-add-remaining-results.json";
const apply = process.argv.includes("--apply");

if (existsSync(resultsPath)) chmodSync(resultsPath, 0o600);

const apiBase = "https://openapi.tidal.com/v2";
const collectionPath = "/userCollectionAlbums/me/relationships/items";

const config = loadConfig();
const batchSize = config.sync.batch_size;
const delayBetweenBatchesMs = config.sync.delay_between_batches_ms;
const requestTimeoutMs = 30000;
const maxRetries = 5;
const databasePath = process.env.BCTS_DATABASE ?? config.storage.database;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: any): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  chmodSync(path, 0o600);
}

function asArray(value: any): any[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function absoluteTidalUrl(link: string): string {
  if (link.startsWith("http://") || link.startsWith("https://")) {
    return link;
  }

  return `${apiBase}${link.startsWith("/") ? link : `/${link}`}`;
}

let tokenData = readJson(tokenPath);
let accessToken = tokenData.access_token;

if (!accessToken) {
  throw new Error(`No access_token found in ${tokenPath}`);
}

const grantedScopes = String(tokenData.scope ?? "")
  .split(/\s+/)
  .filter(Boolean);

if (!grantedScopes.includes("collection.write")) {
  throw new Error(
    "Current token does not include collection.write. Re-run tidal-auth.ts with collection.read collection.write.",
  );
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.api+json",
  };
}

let refreshPromise: Promise<void> | null = null;

async function refreshAccessToken(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const clientId = process.env.TIDAL_CLIENT_ID;

    if (!clientId) {
      throw new Error(
        "Missing TIDAL_CLIENT_ID in environment; cannot refresh token.",
      );
    }

    if (!tokenData.refresh_token) {
      throw new Error(
        "No refresh_token in tidal-tokens.json. Re-run tidal-auth.ts.",
      );
    }

    console.log("  Refreshing TIDAL access token...");

    const response = await fetch("https://auth.tidal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokenData.refresh_token,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Token refresh failed: HTTP ${response.status}: ${text.slice(0, 1000)}`,
      );
    }

    const refreshed = JSON.parse(text);

    tokenData = {
      ...tokenData,
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? tokenData.refresh_token,
      refreshed_at: new Date().toISOString(),
    };

    accessToken = tokenData.access_token;
    writeJson(tokenPath, tokenData);

    console.log("  TIDAL access token refreshed.");
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function getJson(url: string, tokenRefreshed = false): Promise<any> {
  const response = await request(
    url,
    { headers: authHeaders() },
    { retries: maxRetries, baseDelayMs: 3000, timeoutMs: requestTimeoutMs },
  );

  const text = await response.text();

  if (shouldRefreshToken(response.status, tokenRefreshed)) {
    console.log("  Access token rejected; attempting refresh.");
    await refreshAccessToken();
    return getJson(url, true);
  }

  if (classifyWriteOutcome(response.status) !== "success") {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  return text ? JSON.parse(text) : null;
}

async function postJson(
  url: string,
  payload: any,
  idempotencyKey: string,
  tokenRefreshed = false,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const response = await request(
    url,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/vnd.api+json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    },
    { retries: maxRetries, baseDelayMs: 3000, timeoutMs: requestTimeoutMs },
  );

  const body = await response.text();

  if (shouldRefreshToken(response.status, tokenRefreshed)) {
    console.log("  Access token rejected; attempting refresh.");
    await refreshAccessToken();

    return postJson(url, payload, idempotencyKey, true);
  }

  if (classifyWriteOutcome(response.status) !== "success") {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }

  return {
    status: response.status,
    body,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function fetchCurrentLibraryIds(): Promise<Set<string>> {
  const initialUrl = new URL(`${apiBase}/userCollectionAlbums/me`);

  initialUrl.searchParams.set(
    "countryCode",
    config.providers.tidal.country_code,
  );
  initialUrl.searchParams.set("locale", config.providers.tidal.locale);
  initialUrl.searchParams.set("include", "items");

  console.log("Refreshing current TIDAL library before writing...");

  const initialDocument = await getJson(initialUrl.toString());
  const collection = initialDocument?.data;

  if (collection?.type !== "userCollectionAlbums") {
    throw new Error(
      "Could not read the authenticated userCollectionAlbums resource.",
    );
  }

  const ids = new Set<string>();

  for (const item of asArray(collection.relationships?.items?.data)) {
    if (item?.type === "albums" && item?.id) {
      ids.add(String(item.id));
    }
  }

  let nextUrl: string | null = collection.relationships?.items?.links?.next
    ? absoluteTidalUrl(collection.relationships.items.links.next)
    : null;

  let page = 1;

  while (nextUrl) {
    page++;

    const document = await getJson(nextUrl);

    for (const item of asArray(document?.data)) {
      if (item?.type === "albums" && item?.id) {
        ids.add(String(item.id));
      }
    }

    nextUrl = document?.links?.next
      ? absoluteTidalUrl(document.links.next)
      : null;

    if (page % 10 === 0) {
      console.log(`  Read ${ids.size} saved albums so far...`);
    }

    await sleep(300);
  }

  console.log(`Current library contains ${ids.size} albums.`);
  return ids;
}

const manifest = readJson(manifestPath);

if (
  !manifest ||
  !Array.isArray(manifest.albums) ||
  manifest.album_count !== manifest.albums.length
) {
  throw new Error(`Invalid manifest structure in ${manifestPath}.`);
}

const manifestAlbums = manifest.albums;
const uniqueById = new Map<string, any>();

for (const album of manifestAlbums) {
  const id = String(album?.tidal_album_id ?? "");

  if (!id) {
    throw new Error("Manifest contains an album with no tidal_album_id.");
  }

  if (uniqueById.has(id)) {
    throw new Error(`Manifest has duplicate TIDAL album ID: ${id}`);
  }

  uniqueById.set(id, album);
}

if (uniqueById.size > config.sync.max_additions_per_run) {
  throw new Error(
    `Safety stop: manifest contains ${uniqueById.size} albums, above the configured maximum of ${config.sync.max_additions_per_run}.`,
  );
}

if (!apply) {
  const localLibrary = existsSync("./output/tidal-library.json")
    ? new Set(
        asArray(readJson("./output/tidal-library.json")).map((album) =>
          String(album?.tidal_album_id ?? ""),
        ),
      )
    : new Set<string>();
  const alreadySaved = [...uniqueById.keys()].filter((id) =>
    localLibrary.has(id),
  ).length;
  console.log(
    "Dry run only. Re-run with --apply to write the manifest to TIDAL.",
  );
  console.log(`Manifest IDs: ${uniqueById.size}`);
  console.log(`Already in exported library: ${alreadySaved}`);
  console.log(`Pending additions: ${uniqueById.size - alreadySaved}`);
  process.exit(0);
}

const existingResults = existsSync(resultsPath)
  ? readJson(resultsPath)
  : {
      created_at: new Date().toISOString(),
      manifest_path: manifestPath,
      manifest_album_count: uniqueById.size,
      batch_size: batchSize,
      batches: [],
    };

if (!Array.isArray(existingResults.batches)) {
  throw new Error(`Invalid results structure in ${resultsPath}.`);
}

const completedIds = successfulIds(existingResults.batches);

const liveLibraryIds = await fetchCurrentLibraryIds();

const pending = [...uniqueById.values()].filter((album) => {
  const id = String(album.tidal_album_id);

  return !completedIds.has(id) && !liveLibraryIds.has(id);
});

const skippedAlreadySaved = [...uniqueById.values()]
  .filter((album) => liveLibraryIds.has(String(album.tidal_album_id)))
  .map((album) => String(album.tidal_album_id));

console.log(`\nManifest IDs: ${uniqueById.size}`);

console.log(`Already recorded as successful: ${completedIds.size}`);

console.log(`Already in current library: ${skippedAlreadySaved.length}`);

console.log(`Pending additions: ${pending.length}`);

if (pending.length === 0) {
  console.log(
    "\nNothing to add. All manifest albums are already saved or recorded as successful.",
  );

  writeJson(resultsPath, {
    ...existingResults,
    last_checked_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    final_pending_count: 0,
  });

  process.exit(0);
}

const batches = createBatches(pending, batchSize);
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
const syncStore = new SyncStore(database);
const syncRunId = syncStore.startRun("write");

console.log(
  `Will send ${batches.length} batch(es): ` +
    batches.map((batch) => batch.length).join(", "),
);

const endpoint = `${apiBase}${collectionPath}`;

for (const [index, batch] of batches.entries()) {
  const albumIds = batch.map((album) => String(album.tidal_album_id));

  const payload = {
    data: albumIds.map((id) => ({
      id,
      type: "albums",
    })),
  };

  const idempotencyKey = idempotencyKeyForBatch(manifestPath, albumIds);

  const batchRecord: any = {
    batch_number: existingResults.batches.length + 1,
    run_batch_number: index + 1,
    started_at: new Date().toISOString(),
    endpoint,
    idempotency_key: idempotencyKey,
    album_count: albumIds.length,
    album_ids: albumIds,
    albums: batch.map((album) => ({
      tidal_album_id: String(album.tidal_album_id),
      tidal_title: album.tidal_title ?? "",
      tidal_artists: album.tidal_artists ?? [],
      bandcamp_artist: album.bandcamp_artist ?? "",
      bandcamp_title: album.bandcamp_title ?? "",
      match_score: album.match_score ?? "",
    })),
    payload,
    ok: false,
  };
  syncStore.recordBatch(
    syncRunId,
    batchRecord.batch_number,
    albumIds,
    idempotencyKey,
  );

  console.log(
    `\nBatch ${index + 1}/${batches.length}: adding ${albumIds.length} albums.`,
  );

  try {
    const response = await postJson(endpoint, payload, idempotencyKey);

    batchRecord.ok = true;
    batchRecord.status = response.status;
    batchRecord.response_headers = response.headers;
    batchRecord.response_body = response.body;
    batchRecord.finished_at = new Date().toISOString();

    console.log(`  Success: HTTP ${response.status}.`);
  } catch (error) {
    batchRecord.ok = false;
    batchRecord.error = error instanceof Error ? error.message : String(error);
    batchRecord.finished_at = new Date().toISOString();

    console.error(`  Batch failed: ${batchRecord.error}`);
    syncStore.completeBatch(syncRunId, batchRecord.batch_number, false);
    syncStore.finishRun(syncRunId, "failed");
    database.close();

    existingResults.batches.push(batchRecord);

    writeJson(resultsPath, {
      ...existingResults,
      last_updated_at: new Date().toISOString(),
      stopped_after_failed_batch: batchRecord.batch_number,
    });

    console.error(
      "\nStopped. Fix the cause, then run this script again. " +
        "It will skip confirmed successful batches.",
    );

    process.exitCode = 1;
    break;
  }

  existingResults.batches.push(batchRecord);
  syncStore.completeBatch(syncRunId, batchRecord.batch_number, true);

  writeJson(resultsPath, {
    ...existingResults,
    last_updated_at: new Date().toISOString(),
  });

  if (index < batches.length - 1) {
    console.log(
      `  Waiting ${delayBetweenBatchesMs} ms before the next batch...`,
    );

    await sleep(delayBetweenBatchesMs);
  }
}

syncStore.finishRun(syncRunId, "completed");
database.close();

const finalSuccessfulIds = new Set<string>();

for (const batch of existingResults.batches) {
  if (batch?.ok === true) {
    for (const id of batch.album_ids ?? []) {
      finalSuccessfulIds.add(String(id));
    }
  }
}

const finalResult = {
  ...existingResults,
  last_updated_at: new Date().toISOString(),
  completed_at:
    finalSuccessfulIds.size >= pending.length
      ? new Date().toISOString()
      : undefined,
  summary: {
    manifest_album_count: uniqueById.size,
    saved_before_run: skippedAlreadySaved.length,
    added_or_recorded_successfully: finalSuccessfulIds.size,
    pending_at_run_start: pending.length,
    batches_recorded: existingResults.batches.length,
    successful_batches: existingResults.batches.filter(
      (batch: any) => batch.ok === true,
    ).length,
    failed_batches: existingResults.batches.filter(
      (batch: any) => batch.ok !== true,
    ).length,
  },
};

writeJson(resultsPath, finalResult);

console.log("\nRun summary:");
console.log(finalResult.summary);
console.log(`Wrote ${resultsPath}`);
