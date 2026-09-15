import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  type AdditionCandidate,
  createAdditionPlan,
} from "../src/addition-plan";

const candidatesPath = "./output/high-confidence-to-save.json";
const libraryPath = "./output/tidal-library.json";
const pilotPath = "./output/tidal-add-pilot-10.json";
const remainingPath = "./output/tidal-add-remaining.json";

const candidates = JSON.parse(
  readFileSync(candidatesPath, "utf8"),
) as AdditionCandidate[];
const library = JSON.parse(readFileSync(libraryPath, "utf8")) as Array<{
  tidal_album_id: string | number;
}>;
const plan = createAdditionPlan(
  candidates,
  library.map((album) => String(album.tidal_album_id)),
);
const createdAt = new Date().toISOString();

function writeManifest(
  path: string,
  purpose: string,
  albums: AdditionCandidate[],
): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema_version: 1,
        created_at: createdAt,
        source: candidatesPath,
        library_snapshot: libraryPath,
        purpose,
        intended_collection: "me",
        album_count: albums.length,
        albums,
      },
      null,
      2,
    ),
    "utf8",
  );
  chmodSync(path, 0o600);
}

writeManifest(pilotPath, "pilot_add_to_tidal_collection", plan.pilot);
writeManifest(
  remainingPath,
  "remaining_high_confidence_additions",
  plan.remaining,
);

console.log(`Fresh candidates: ${candidates.length}`);
console.log(
  `Skipped because already saved: ${plan.skippedAlreadySaved.length}`,
);
console.log(`Pilot: ${plan.pilot.length}`);
console.log(`Remaining after pilot: ${plan.remaining.length}`);
console.log("Provider writes: 0");
