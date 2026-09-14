import { readFileSync } from "node:fs";

const tokenData = JSON.parse(
  readFileSync("./output/tidal-tokens.json", "utf8")
);

const url = new URL(
  "https://openapi.tidal.com/v2/userCollectionAlbums/me"
);

url.searchParams.set("locale", "en-US");
url.searchParams.set("include", "items,owners");
url.searchParams.set("countryCode", "DE");

const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${tokenData.access_token}`,
    Accept: "application/vnd.api+json",
  },
});

const document = await response.json();

console.log(`Status: ${response.status}`);

console.log(JSON.stringify({
  top_level_links: document.links,
  collection_id: document.data?.id,
  collection_type: document.data?.type,
  collection_attributes: document.data?.attributes,
  items_relationship: document.data?.relationships?.items,
  owners_relationship: document.data?.relationships?.owners,
  included_count: document.included?.length,
  included_types: (document.included ?? []).reduce(
    (counts: Record<string, number>, resource: any) => {
      counts[resource.type] = (counts[resource.type] ?? 0) + 1;
      return counts;
    },
    {}
  ),
}, null, 2));
