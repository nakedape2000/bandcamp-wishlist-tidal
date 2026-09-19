import { loadConfig } from "../src/config";
import { writeSnapshot } from "../src/output";
import { createBandcampSourceAdapter } from "../src/providers/bandcamp-source-adapter";
import { Terminal } from "../src/terminal";
import type { WishlistSnapshot } from "../src/types";

const config = loadConfig();
const username =
  process.env.BCTS_USERNAME ?? config.providers.bandcamp.username;
if (!username)
  throw new Error(
    "Bandcamp username is required. Run `bandcamp-tidal-sync config set providers.bandcamp.username <name>` or set BCTS_USERNAME.",
  );
const terminal = new Terminal({
  json: process.argv.includes("--json"),
  quiet: process.argv.includes("--quiet"),
  verbose: process.argv.includes("--verbose"),
  color:
    !process.argv.includes("--no-color") &&
    !process.env.NO_COLOR &&
    Boolean(process.stderr.isTTY),
});
const outputPath =
  process.env.BCTS_WISHLIST_SNAPSHOT ??
  `${config.storage.output_dir}/wishlist.json`;
const source = await createBandcampSourceAdapter().fetchWishlist(username, {
  onProgress: (loaded) => terminal.progress("Fetched wishlist items", loaded),
});
terminal.endProgress();
const snapshot: WishlistSnapshot = {
  schema_version: 1,
  source: "bandcamp",
  username: source.username,
  fanId: source.fanId,
  fetchedAt: source.fetchedAt,
  count: source.items.length,
  items: source.items,
};
await writeSnapshot(snapshot, outputPath, true);
if (process.env.BCTS_PIPELINE !== "1")
  terminal.output(
    { item_count: source.items.length, output: outputPath, provider_writes: 0 },
    `Wrote ${source.items.length} wishlist items to ${outputPath}`,
  );
