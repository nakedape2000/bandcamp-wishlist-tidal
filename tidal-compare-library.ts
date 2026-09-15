import { readFileSync, writeFileSync } from "node:fs";

const matches = JSON.parse(readFileSync("./output/tidal-matches.json", "utf8"));

const library = JSON.parse(readFileSync("./output/tidal-library.json", "utf8"));

const libraryIds = new Set(
  library.map((album: any) => String(album.tidal_album_id)).filter(Boolean),
);

const highConfidence = matches.filter(
  (item: any) =>
    item.status === "high_confidence" && item.best_match?.tidal_album_id,
);

const alreadySaved = [];
const toSave = [];

for (const item of highConfidence) {
  const tidalAlbumId = String(item.best_match.tidal_album_id);

  const record = {
    bandcamp_item_id: item.bandcamp_item_id ?? "",
    bandcamp_artist: item.bandcamp_artist ?? "",
    bandcamp_title: item.bandcamp_title ?? "",
    bandcamp_url: item.bandcamp_url ?? "",
    bandcamp_label_hint: item.bandcamp_label_hint ?? "",
    match_status: item.status,
    match_score: item.best_match.score ?? "",
    tidal_album_id: tidalAlbumId,
    tidal_title: item.best_match.tidal_title ?? "",
    tidal_artists: item.best_match.tidal_artists ?? [],
    tidal_release_date: item.best_match.tidal_release_date ?? "",
    tidal_track_count: item.best_match.tidal_track_count ?? "",
    tidal_copyright: item.best_match.tidal_copyright ?? "",
    tidal_album_type: item.best_match.tidal_album_type ?? "",
    tidal_availability: item.best_match.tidal_availability ?? [],
    tidal_url:
      item.best_match.tidal_url ??
      `https://tidal.com/browse/album/${tidalAlbumId}`,
  };

  if (libraryIds.has(tidalAlbumId)) {
    alreadySaved.push(record);
  } else {
    toSave.push(record);
  }
}

alreadySaved.sort((a, b) =>
  `${a.bandcamp_artist} ${a.bandcamp_title}`.localeCompare(
    `${b.bandcamp_artist} ${b.bandcamp_title}`,
  ),
);

toSave.sort((a, b) =>
  `${a.bandcamp_artist} ${a.bandcamp_title}`.localeCompare(
    `${b.bandcamp_artist} ${b.bandcamp_title}`,
  ),
);

function csvEscape(value: unknown): string {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");

  return `"${text.replaceAll('"', '""')}"`;
}

const columns = [
  "bandcamp_item_id",
  "bandcamp_artist",
  "bandcamp_title",
  "bandcamp_url",
  "bandcamp_label_hint",
  "match_status",
  "match_score",
  "tidal_album_id",
  "tidal_title",
  "tidal_artists",
  "tidal_release_date",
  "tidal_track_count",
  "tidal_copyright",
  "tidal_album_type",
  "tidal_availability",
  "tidal_url",
];

function writeCsv(path: string, records: any[]) {
  const csv = [
    columns.join(","),
    ...records.map((record) =>
      columns.map((column) => csvEscape(record[column])).join(","),
    ),
  ].join("\r\n");

  writeFileSync(path, csv, "utf8");
}

writeFileSync(
  "./output/high-confidence-already-saved.json",
  JSON.stringify(alreadySaved, null, 2),
  "utf8",
);

writeFileSync(
  "./output/high-confidence-to-save.json",
  JSON.stringify(toSave, null, 2),
  "utf8",
);

writeCsv("./output/high-confidence-already-saved.csv", alreadySaved);

writeCsv("./output/high-confidence-to-save.csv", toSave);

const summary = {
  tidal_library_album_count: libraryIds.size,
  high_confidence_match_count: highConfidence.length,
  already_saved_count: alreadySaved.length,
  to_save_count: toSave.length,
};

writeFileSync(
  "./output/high-confidence-library-comparison-summary.json",
  JSON.stringify(summary, null, 2),
  "utf8",
);

console.log("\nComparison complete:");
console.table(summary);

console.log("\nWrote ./output/high-confidence-already-saved.csv");

console.log("Wrote ./output/high-confidence-to-save.csv");

console.log("Wrote ./output/high-confidence-library-comparison-summary.json");
