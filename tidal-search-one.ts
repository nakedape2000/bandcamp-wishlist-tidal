import { readFileSync } from "node:fs";

const tokenData = JSON.parse(
  readFileSync("./output/tidal-tokens.json", "utf8")
);

const accessToken = tokenData.access_token;

const headers = {
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/vnd.api+json",
};

async function getJson(url: string): Promise<any> {
  console.log(`GET ${url}`);

  const response = await fetch(url, { headers });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

function resolveTidalUrl(link: string): string {
  if (link.startsWith("http://") || link.startsWith("https://")) {
    return link;
  }

  const path = link.startsWith("/")
    ? link
    : `/${link}`;

  return `https://openapi.tidal.com/v2${path}`;
}

const searchUrl = new URL(
  "https://openapi.tidal.com/v2/searchResults"
);

searchUrl.searchParams.set("countryCode", "DE");
searchUrl.searchParams.set("filter[query]", "Pond");

const searchDocument = await getJson(searchUrl.toString());
const searchResultId = searchDocument.data?.[0]?.id;

if (!searchResultId) {
  throw new Error("No search result ID returned");
}

let nextUrl: string | null =
  `https://openapi.tidal.com/v2/searchResults/${searchResultId}/relationships/albums?countryCode=DE`;

const allIds: string[] = [];
let page = 0;

while (nextUrl) {
  page++;

  const document = await getJson(nextUrl);
  const albums = document.data ?? [];

  console.log(`Page ${page}: ${albums.length} albums`);

  for (const album of albums) {
    allIds.push(album.id);
  }

  nextUrl = document.links?.next
    ? resolveTidalUrl(document.links.next)
    : null;
}

console.log(`Total album IDs: ${allIds.length}`);
console.log(allIds.join("\n"));

console.log(
  allIds.includes("527114775")
    ? "\nFOUND album 527114775"
    : "\nAlbum 527114775 was not returned"
);
