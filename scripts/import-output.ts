import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildImportState } from "../src/import-state";

const outputDir = process.env.BCTS_OUTPUT_DIR ?? "./output";
const destination =
  process.env.BCTS_IMPORT_DEST ?? `${outputDir}/imported-state.v1.json`;
const names = [
  "wishlist.json",
  "wishlist-backup.json",
  "tidal-matches.json",
  "tidal-library.json",
  "high-confidence-to-save.json",
  "high-confidence-already-saved.json",
  "tidal-add-remaining.json",
  "tidal-add-remaining-results.json",
];

const files: Record<string, unknown> = {};
for (const name of names) {
  const path = `${outputDir}/${name}`;
  if (!existsSync(path)) continue;
  try {
    files[name] = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const state = buildImportState(files);
writeFileSync(destination, JSON.stringify(state, null, 2), "utf8");
chmodSync(destination, 0o600);
console.log(
  `Imported ${Object.keys(files).length} JSON artifacts → ${destination}`,
);
