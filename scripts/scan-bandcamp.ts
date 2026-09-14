import { fetchAllWishlistItems, resolveFanId } from "../src/bandcamp";
import { loadConfig } from "../src/config";
import { writeSnapshot } from "../src/output";
import { Terminal } from "../src/terminal";
import type { WishlistSnapshot } from "../src/types";

const config = loadConfig();
const username =
  process.env.BCTS_USERNAME ?? config.providers.bandcamp.username;
if (!username)
  throw new Error(
    "Bandcamp username is required. Run `sync config set providers.bandcamp.username <name>` or set BCTS_USERNAME.",
  );
const terminal = new Terminal({
  json: process.argv.includes("--json"),
  quiet: process.argv.includes("--quiet"),
  verbose: process.argv.includes("--verbose"),
  color:
    !process.argv.includes("--no-color") &&
    !process.env.NO_COLOR &&
    process.stderr.isTTY,
});
const outputPath =
  process.env.BCTS_WISHLIST_SNAPSHOT ??
  `${config.storage.output_dir}/wishlist.json`;
const fanId = await resolveFanId(username);
const items = await fetchAllWishlistItems(fanId, 100, (loaded) =>
  terminal.progress("Fetched wishlist items", loaded),
);
terminal.endProgress();
const snapshot: WishlistSnapshot = {
  schema_version: 1,
  source: "bandcamp",
  username,
  fanId,
  fetchedAt: new Date().toISOString(),
  count: items.length,
  items,
};
await writeSnapshot(snapshot, outputPath, true);
if (process.env.BCTS_PIPELINE !== "1")
  terminal.output(
    { item_count: items.length, output: outputPath, provider_writes: 0 },
    `Wrote ${items.length} wishlist items to ${outputPath}`,
  );
