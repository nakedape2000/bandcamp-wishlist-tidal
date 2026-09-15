import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync("./output/high-confidence-to-save.json", "utf8"),
);

const dryRun = true;
const batchSize = 25;

const albums = manifest.filter((item: any) => item.tidal_album_id);

const unique = new Map<string, any>();

for (const album of albums) {
  unique.set(String(album.tidal_album_id), album);
}

const uniqueAlbums = [...unique.values()];
const batches = [];

for (let index = 0; index < uniqueAlbums.length; index += batchSize) {
  batches.push(uniqueAlbums.slice(index, index + batchSize));
}

const report = {
  dry_run: dryRun,
  collection: "me",
  endpoint: "POST /v2/userCollectionAlbums/me/relationships/items",
  total_albums: uniqueAlbums.length,
  batch_size: batchSize,
  batch_count: batches.length,
  batches: batches.map((batch, index) => ({
    batch_number: index + 1,
    idempotency_key: randomUUID(),
    albums: batch.map((album: any) => ({
      tidal_album_id: String(album.tidal_album_id),
      tidal_title: album.tidal_title ?? "",
      tidal_artists: album.tidal_artists ?? [],
      tidal_url:
        album.tidal_url ??
        `https://tidal.com/browse/album/${album.tidal_album_id}`,
      bandcamp_artist: album.bandcamp_artist ?? "",
      bandcamp_title: album.bandcamp_title ?? "",
      match_score: album.match_score ?? "",
    })),
  })),
};

writeFileSync(
  "./output/tidal-add-dry-run.json",
  JSON.stringify(report, null, 2),
  "utf8",
);

console.log("Dry run only; no TIDAL changes were made.");
console.log(`Unique albums: ${uniqueAlbums.length}`);
console.log(`Batch size: ${batchSize}`);
console.log(`Batch count: ${batches.length}`);
console.log("Wrote ./output/tidal-add-dry-run.json");
