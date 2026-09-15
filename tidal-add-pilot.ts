import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { idempotencyKeyForBatch } from "./src/batches";
import { fetchTidalLibraryIds, TidalClient } from "./src/tidal";

const tokenPath = "./output/tidal-tokens.json";
const manifestPath = "./output/tidal-add-pilot-10.json";
const resultPath = "./output/tidal-add-pilot-result.json";
const apply = process.argv.includes("--apply");

for (const path of [resultPath, "./output/tidal-add-pilot-request.json"]) {
  if (existsSync(path)) chmodSync(path, 0o600);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const albums = manifest.albums ?? [];

if (!Array.isArray(albums) || albums.length < 1 || albums.length > 10) {
  throw new Error(
    `Expected between 1 and 10 albums in ${manifestPath}; found ${albums.length}.`,
  );
}

const ids = albums.map((album: any) => String(album.tidal_album_id ?? ""));

if (ids.some((id: string) => !id)) {
  throw new Error("Pilot manifest contains an empty TIDAL album ID.");
}

const uniqueIds = [...new Set(ids)];

if (uniqueIds.length !== albums.length) {
  throw new Error(
    `Expected ${albums.length} unique album IDs; found ${uniqueIds.length}.`,
  );
}

const endpoint =
  "https://openapi.tidal.com/v2/userCollectionAlbums/me/relationships/items";

let idempotencyKey = idempotencyKeyForBatch(manifestPath, uniqueIds);

let payload = {
  data: uniqueIds.map((id) => ({
    id,
    type: "albums",
  })),
};

let requestAudit = {
  started_at: new Date().toISOString(),
  endpoint,
  idempotency_key: idempotencyKey,
  manifest_path: manifestPath,
  album_count: uniqueIds.length,
  albums,
  payload,
};

if (!apply) {
  const localLibrary = existsSync("./output/tidal-library.json")
    ? new Set(
        (
          JSON.parse(
            readFileSync("./output/tidal-library.json", "utf8"),
          ) as Array<{ tidal_album_id?: unknown }>
        ).map((album) => String(album.tidal_album_id ?? "")),
      )
    : new Set<string>();
  const alreadySaved = uniqueIds.filter((id) => localLibrary.has(id)).length;
  console.log(
    "Dry run only. Re-run with --apply to write these albums to TIDAL.",
  );
  console.log(`Manifest IDs: ${uniqueIds.length}`);
  console.log(`Already in exported library: ${alreadySaved}`);
  console.log(`Pending additions: ${uniqueIds.length - alreadySaved}`);
  writeFileSync(
    resultPath,
    JSON.stringify({ ...requestAudit, dry_run: true }, null, 2),
    "utf8",
  );
  chmodSync(resultPath, 0o600);
  process.exit(0);
}

const client = new TidalClient({ tokenPath });
const liveLibraryIds = await fetchTidalLibraryIds(client);
const pendingIds = uniqueIds.filter((id) => !liveLibraryIds.has(id));
const skippedIds = uniqueIds.filter((id) => liveLibraryIds.has(id));

console.log(`Live library albums: ${liveLibraryIds.size}`);
console.log(`Already saved and skipped: ${skippedIds.length}`);
console.log(`Pending pilot additions: ${pendingIds.length}`);

if (pendingIds.length === 0) {
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        ...requestAudit,
        finished_at: new Date().toISOString(),
        ok: true,
        provider_write: false,
        skipped_album_ids: skippedIds,
        response_body: "All pilot albums are already saved.",
      },
      null,
      2,
    ),
    "utf8",
  );
  chmodSync(resultPath, 0o600);
  console.log("Nothing to add; no provider write was made.");
  process.exit(0);
}

idempotencyKey = idempotencyKeyForBatch(manifestPath, pendingIds);
payload = {
  data: pendingIds.map((id) => ({ id, type: "albums" })),
};
requestAudit = {
  ...requestAudit,
  idempotency_key: idempotencyKey,
  album_count: pendingIds.length,
  skipped_album_ids: skippedIds,
  payload,
};

writeFileSync(
  "./output/tidal-add-pilot-request.json",
  JSON.stringify(requestAudit, null, 2),
  "utf8",
);
chmodSync("./output/tidal-add-pilot-request.json", 0o600);

console.log(`Adding exactly these ${pendingIds.length} albums:`);
for (const [index, album] of albums
  .filter((album: any) => pendingIds.includes(String(album.tidal_album_id)))
  .entries()) {
  console.log(
    `${index + 1}. ${(Array.isArray(album.tidal_artists) ? album.tidal_artists : []).join(", ")} — ` +
      `${album.tidal_title} (${album.tidal_album_id})`,
  );
}

console.log("\nPOST", endpoint);
console.log("Idempotency-Key:", idempotencyKey);

let responseStatus = 0;
let responseText = "";
let responseOk = true;
try {
  const result = await client.post<unknown>(endpoint, payload, idempotencyKey);
  responseStatus = result.status;
  responseText = JSON.stringify(result.body);
} catch (error) {
  responseOk = false;
  responseText = error instanceof Error ? error.message : String(error);
}

const resultAudit = {
  ...requestAudit,
  finished_at: new Date().toISOString(),
  status: responseStatus,
  ok: responseOk,
  response_headers: {},
  response_body: responseText,
};

writeFileSync(resultPath, JSON.stringify(resultAudit, null, 2), "utf8");
chmodSync(resultPath, 0o600);

console.log(`\nHTTP ${responseStatus}`);
console.log(
  responseText ? responseText.slice(0, 5000) : "(empty response body)",
);

console.log(`\nWrote ${resultPath}`);

if (!responseOk) {
  process.exitCode = 1;
}
