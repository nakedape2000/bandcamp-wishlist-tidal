import { extractDataBlob, normalizeItem, readFanId } from "../src/parse";
import type { RawApiItem } from "../src/types";

const html = await Bun.file("test/fixtures/data-blob.html").text();
const api = (await Bun.file("test/fixtures/api-response.json").json()) as {
  items?: RawApiItem[];
};

const fanId = readFanId(extractDataBlob(html));
const items = (api.items ?? []).map(normalizeItem);

const plan = {
  schema_version: 1,
  mode: "fixture-dry-run" as const,
  source: "bandcamp" as const,
  item_count: items.length,
  provider_writes: 0 as const,
  items: items.map(({ itemId, itemType, artist, title, url }) => ({
    itemId,
    itemType,
    artist,
    title,
    url,
  })),
};

console.log(JSON.stringify({ fan_id: fanId, ...plan }, null, 2));
