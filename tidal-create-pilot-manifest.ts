import { readFileSync, writeFileSync } from "node:fs";

const candidates = JSON.parse(
  readFileSync("./output/high-confidence-to-save.json", "utf8"),
);

const pilotSize = 10;

const unique = new Map<string, any>();

for (const item of candidates) {
  const id = String(item.tidal_album_id ?? "");

  if (id && !unique.has(id)) {
    unique.set(id, item);
  }
}

const albums = [...unique.values()].slice(0, pilotSize).map((item: any) => ({
  tidal_album_id: String(item.tidal_album_id),
  tidal_title: item.tidal_title ?? "",
  tidal_artists: item.tidal_artists ?? [],
  tidal_url:
    item.tidal_url ?? `https://tidal.com/browse/album/${item.tidal_album_id}`,
  bandcamp_artist: item.bandcamp_artist ?? "",
  bandcamp_title: item.bandcamp_title ?? "",
  bandcamp_url: item.bandcamp_url ?? "",
  match_score: item.match_score ?? "",
}));

if (albums.length !== pilotSize) {
  throw new Error(
    `Expected ${pilotSize} unique candidates, found ${albums.length}.`,
  );
}

const manifest = {
  created_at: new Date().toISOString(),
  source: "./output/high-confidence-to-save.json",
  purpose: "pilot_add_to_tidal_collection",
  intended_collection: "me",
  album_count: albums.length,
  albums,
};

writeFileSync(
  "./output/tidal-add-pilot-10.json",
  JSON.stringify(manifest, null, 2),
  "utf8",
);

console.log(`Created a ${albums.length}-album pilot manifest.`);
console.log("Wrote ./output/tidal-add-pilot-10.json");

for (const [index, album] of albums.entries()) {
  console.log(
    `${index + 1}. ${album.tidal_artists.join(", ")} — ${album.tidal_title} (${album.tidal_album_id})`,
  );
}
