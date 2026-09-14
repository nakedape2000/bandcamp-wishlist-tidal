import { readFileSync, writeFileSync } from "node:fs";

const sourcePath = "./output/high-confidence-to-save.json";
const outputPath = "./output/tidal-add-remaining.json";

const candidates = JSON.parse(readFileSync(sourcePath, "utf8"));

const unique = new Map<string, any>();

for (const item of candidates) {
  const id = String(item.tidal_album_id ?? "");

  if (!id || unique.has(id)) {
    continue;
  }

  unique.set(id, {
    tidal_album_id: id,
    tidal_title: item.tidal_title ?? "",
    tidal_artists: item.tidal_artists ?? [],
    tidal_url: item.tidal_url ?? `https://tidal.com/browse/album/${id}`,
    bandcamp_artist: item.bandcamp_artist ?? "",
    bandcamp_title: item.bandcamp_title ?? "",
    bandcamp_url: item.bandcamp_url ?? "",
    match_score: item.match_score ?? "",
  });
}

const albums = [...unique.values()];

const manifest = {
  created_at: new Date().toISOString(),
  source: sourcePath,
  purpose: "remaining_high_confidence_additions",
  intended_collection: "me",
  album_count: albums.length,
  albums,
};

writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf8");

console.log(`Created a manifest for ${albums.length} remaining albums.`);

console.log(`Wrote ${outputPath}`);

console.log("\nFirst 10 albums:");
for (const [index, album] of albums.slice(0, 10).entries()) {
  const artists = album.tidal_artists.join(", ") || "Unknown artist";

  console.log(
    `${index + 1}. ${artists} — ${album.tidal_title} ` +
      `(${album.tidal_album_id})`,
  );
}
