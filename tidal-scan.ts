import { readFileSync, writeFileSync } from "node:fs";

const tokenData = JSON.parse(
  readFileSync("./output/tidal-tokens.json", "utf8")
);

const wishlistData = JSON.parse(
  readFileSync("./output/wishlist.json", "utf8")
);

const accessToken = tokenData.access_token;
const countryCode = "DE";
const apiBase = "https://openapi.tidal.com/v2";
const testOnly = false;
const testItemLimit = 5;
const maxCandidates = 30;

if (!accessToken) {
  throw new Error("Missing access_token in ./output/tidal-tokens.json");
}

const headers = {
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/vnd.api+json",
};

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url: string, attempt = 1): Promise<any> {
  console.log(`  GET ${url}`);

  let response: Response;

  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (attempt <= 3) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  Request failed: ${message}`);
      console.log(`  Retrying attempt ${attempt + 1}/3...`);
      await sleep(attempt * 2500);
      return getJson(url, attempt + 1);
    }

    throw new Error(`Request timed out or failed: ${url}`);
  }

  const text = await response.text();

  if (response.status === 429) {
    if (attempt <= 5) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : attempt * 5000;

      console.log(`  HTTP 429; waiting ${waitMs} ms`);
      await sleep(waitMs);
      return getJson(url, attempt + 1);
    }

    throw new Error("HTTP 429: rate limit retries exhausted");
  }

  if (response.status >= 500 && attempt <= 4) {
    console.log(`  HTTP ${response.status}; retrying...`);
    await sleep(attempt * 3000);
    return getJson(url, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return JSON.parse(text);
}

function resolveTidalUrl(link: string): string {
  if (link.startsWith("http://") || link.startsWith("https://")) {
    return link;
  }

  const path = link.startsWith("/") ? link : `/${link}`;
  return `${apiBase}${path}`;
}

function cleanTitle(title: string): string {
  const separators = [" - ", " – ", " — ", ": "];

  for (const separator of separators) {
    const position = title.indexOf(separator);

    if (position > 0) {
      const prefix = title.slice(0, position);

      if (prefix.length <= 12 && /[0-9]/.test(prefix)) {
        return title.slice(position + separator.length).trim();
      }
    }
  }

  return title.trim();
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bandcampLabelHint(url: string): string {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "")
      .replace(/\.bandcamp\.com$/, "")
      .replace(/[-_]+/g, " ");
  } catch {
    return "";
  }
}

function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);

  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;

  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  const intersection = [...leftWords].filter(word => rightWords.has(word));

  return intersection.length / Math.max(leftWords.size, rightWords.size);
}

function scoreCandidate(
  item: any,
  album: any,
  artistNames: string[]
): number {
  const attributes = album.attributes ?? {};
  const titleScore = similarity(cleanTitle(item.title), attributes.title ?? "");
  const artistScore = similarity(item.artist, artistNames.join(" "));
  const labelHint = normalize(bandcampLabelHint(item.url));
  const copyright = normalize(attributes.copyright?.text ?? "");

  let score = titleScore * 50;
  score += artistScore * 30;

  if (labelHint && copyright.includes(labelHint)) {
    score += 15;
  }

  if (attributes.albumType === "ALBUM") {
    score += 5;
  }

  if (attributes.availability?.includes("STREAM")) {
    score += 5;
  }

  return Math.round(score * 100) / 100;
}

async function searchAlbumIds(query: string): Promise<string[]> {
  const searchUrl = new URL(`${apiBase}/searchResults`);
  searchUrl.searchParams.set("countryCode", countryCode);
  searchUrl.searchParams.set("filter[query]", query);

  const searchDocument = await getJson(searchUrl.toString());
  const searchResultId = searchDocument.data?.[0]?.id;

  if (!searchResultId) return [];

  let nextUrl: string | null =
    `${apiBase}/searchResults/${searchResultId}/relationships/albums?countryCode=${countryCode}`;

  const ids: string[] = [];

  while (nextUrl && ids.length < maxCandidates) {
    const document = await getJson(nextUrl);

    for (const album of document.data ?? []) {
      if (!ids.includes(album.id)) {
        ids.push(album.id);
      }

      if (ids.length >= maxCandidates) break;
    }

    nextUrl = document.links?.next
      ? resolveTidalUrl(document.links.next)
      : null;

    await sleep(700);
  }

  return ids;
}

async function getAlbum(albumId: string): Promise<any> {
  const url = new URL(`${apiBase}/albums/${albumId}`);
  url.searchParams.set("countryCode", countryCode);
  return (await getJson(url.toString())).data;
}

async function getAlbumArtists(albumId: string): Promise<string[]> {
  const url = new URL(
    `${apiBase}/albums/${albumId}/relationships/artists`
  );

  url.searchParams.set("countryCode", countryCode);
  url.searchParams.set("include", "artists");

  const document = await getJson(url.toString());

  return (document.included ?? [])
    .filter((entry: any) => entry.type === "artists")
    .map((entry: any) => entry.attributes?.name)
    .filter(Boolean);
}

const allItems = wishlistData.items.filter(
  (item: any) => item.itemType === "album"
);

const items = testOnly ? allItems.slice(0, testItemLimit) : allItems;
const output: any[] = [];

for (let index = 0; index < items.length; index++) {
  const item = items[index];
  const cleanedTitle = cleanTitle(item.title);

  console.log(`\n[${index + 1}/${items.length}] ${item.artist} — ${item.title}`);

  try {
    const queries = [
      `${item.artist} ${cleanedTitle}`,
      cleanedTitle,
    ];

    const candidateIds = new Set<string>();

    for (const query of queries) {
      for (const id of await searchAlbumIds(query)) {
        candidateIds.add(id);
        if (candidateIds.size >= maxCandidates) break;
      }

      if (candidateIds.size >= maxCandidates) break;
      await sleep(1000);
    }

    const candidates: any[] = [];
    let candidateIndex = 0;

    for (const albumId of candidateIds) {
      candidateIndex++;
      console.log(`  Candidate ${candidateIndex}/${candidateIds.size}: ${albumId}`);

      const album = await getAlbum(albumId);
      const attributes = album.attributes ?? {};
      const titleScore = similarity(cleanedTitle, attributes.title ?? "");

      if (titleScore < 0.5) {
        await sleep(400);
        continue;
      }

      const artists = await getAlbumArtists(albumId);
      const score = scoreCandidate(item, album, artists);

      candidates.push({
        tidal_album_id: albumId,
        tidal_title: attributes.title ?? "",
        tidal_artists: artists,
        tidal_release_date: attributes.releaseDate ?? "",
        tidal_track_count: attributes.numberOfItems ?? null,
        tidal_copyright: attributes.copyright?.text ?? "",
        tidal_album_type: attributes.albumType ?? "",
        tidal_availability: attributes.availability ?? [],
        tidal_url: `https://tidal.com/browse/album/${albumId}`,
        score,
      });

      await sleep(700);
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] ?? null;

    output.push({
      bandcamp_item_id: item.itemId,
      bandcamp_artist: item.artist,
      bandcamp_title: item.title,
      bandcamp_clean_title: cleanedTitle,
      bandcamp_url: item.url,
      bandcamp_label_hint: bandcampLabelHint(item.url),
      status: best
        ? best.score >= 75
          ? "high_confidence"
          : best.score >= 50
            ? "needs_review"
            : "low_confidence"
        : "search_miss",
      best_match: best,
      candidate_count: candidates.length,
      candidates,
    });

    console.log(
      best
        ? `  Best: ${best.score} — ${best.tidal_title}`
        : "  No plausible candidates"
    );
  } catch (error) {
    output.push({
      bandcamp_item_id: item.itemId,
      bandcamp_artist: item.artist,
      bandcamp_title: item.title,
      bandcamp_url: item.url,
      status: "error",
      error: String(error),
    });

    console.log(`  Error: ${String(error)}`);
  }
}

writeFileSync(
  "./output/tidal-matches.json",
  JSON.stringify(output, null, 2),
  "utf8"
);

const csvColumns = [
  "bandcamp_item_id",
  "bandcamp_artist",
  "bandcamp_title",
  "bandcamp_clean_title",
  "bandcamp_url",
  "bandcamp_label_hint",
  "status",
  "candidate_count",
  "tidal_album_id",
  "tidal_title",
  "tidal_artists",
  "tidal_release_date",
  "tidal_track_count",
  "tidal_copyright",
  "tidal_album_type",
  "tidal_availability",
  "score",
  "tidal_url",
];

function csvEscape(value: unknown): string {
  const text = Array.isArray(value)
    ? value.join("; ")
    : String(value ?? "");

  return `"${text.replaceAll('"', '""')}"`;
}

const csvRows = [
  csvColumns.join(","),
  ...output.map(row => {
    const best = row.best_match ?? {};

    return [
      row.bandcamp_item_id,
      row.bandcamp_artist,
      row.bandcamp_title,
      row.bandcamp_clean_title,
      row.bandcamp_url,
      row.bandcamp_label_hint,
      row.status,
      row.candidate_count,
      best.tidal_album_id,
      best.tidal_title,
      best.tidal_artists,
      best.tidal_release_date,
      best.tidal_track_count,
      best.tidal_copyright,
      best.tidal_album_type,
      best.tidal_availability,
      best.score,
      best.tidal_url,
    ].map(csvEscape).join(",");
  }),
];

writeFileSync(
  "./output/tidal-matches.csv",
  csvRows.join("\r\n"),
  "utf8"
);

console.log(`\nFinished. Wrote ${output.length} results.`);
console.log("Wrote ./output/tidal-matches.json");
console.log("Wrote ./output/tidal-matches.csv");
