import { parseArgs } from "node:util";
import { fetchAllWishlistItems, resolveFanId } from "./bandcamp";
import { writeSnapshot } from "./output";
import type { WishlistSnapshot } from "./types";

const USAGE = `bandcamp-wishlist-export — export a public Bandcamp wishlist to JSON

Usage:
  bun run src/cli.ts --user <username> [options]

Options:
  --user <username>   Bandcamp username (bandcamp.com/<username>). Required.
  --out <path>        Output file path (default: ./output/wishlist.json)
  --pretty            Pretty-print the JSON output
  --count <n>         Items per API request (default: 100)
  --help              Show this help`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      user: { type: "string" },
      out: { type: "string", default: "./output/wishlist.json" },
      count: { type: "string", default: "100" },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const username = values.user;
  if (!username) {
    console.error(USAGE);
    process.exit(1);
  }

  const out = values.out as string;
  const count = Number.parseInt(values.count as string, 10) || 100;

  console.log(`Resolving fan id for "${username}"…`);
  const fanId = await resolveFanId(username);

  console.log(`Fetching wishlist (fan_id ${fanId})…`);
  const items = await fetchAllWishlistItems(fanId, count, (n) =>
    process.stdout.write(`\r  ${n} items…`),
  );
  process.stdout.write("\n");

  const snapshot: WishlistSnapshot = {
    schema_version: 1,
    source: "bandcamp",
    username,
    fanId,
    fetchedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  await writeSnapshot(snapshot, out, values.pretty as boolean);
  console.log(`Wrote ${items.length} items → ${out}`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
