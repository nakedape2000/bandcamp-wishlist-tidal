import { readFileSync, writeFileSync, existsSync } from "node:fs";

const tokenPath = "./output/tidal-tokens.json";
const matchesPath = "./output/tidal-matches.json";

const tokenData = JSON.parse(readFileSync(tokenPath, "utf8"));
const matches = JSON.parse(readFileSync(matchesPath, "utf8"));

const accessToken = tokenData.access_token;
const countryCode = "DE";
const apiBase = "https://openapi.tidal.com/v2";

const headers = {
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/vnd.api+json",
};

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url: string, attempt = 1): Promise<any> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();

  if ((response.status === 429 || response.status >= 500) && attempt <= 4) {
    await sleep(attempt * 2000);
    return getJson(url, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return JSON.parse(text);
}

function absoluteTidalUrl(link: string): string {
  if (link.startsWith("http://") || link.startsWith("https://")) {
    return link;
  }

  return `${apiBase}${link.startsWith("/") ? link : `/${link}`}`;
}

function cleanTitle(title: string): string {
  if (!title) return "";
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
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bandcampLabelHint(url: string): string {
  if (!url) return "";

  try {
    const hostname = new URL(url).hostname;
    return hostname
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

  return intersection.length /
    Math.max(leftWords.size, rightWords.size);
}

function scoreCandidate(
  item: any,
  album: any,
  artistNames: string[]
): number {
  const attributes = album?.attributes ?? {};
  const title = cleanTitle(item?.title ?? "");
  const albumTitle = attributes?.title ?? "";
  const artistText = Array.isArray(artistNames)
    ? artistNames.join(" ")
    : "";
  const labelHint = bandcampLabelHint(item?.url ?? "");
  const copyright = attributes?.copyright?.text ?? "";

  let score = 0;

  score += similarity(title, albumTitle) * 50;
  score += similarity(item?.artist ?? "", artistText) * 30;

  if (
    labelHint &&
    normalize(copyright).includes(normalize(labelHint))
  ) {
    score += 15;
  }

  if (attributes?.albumType === "ALBUM") {
    score += 5;
  }

  if (attributes?.availability?.includes("STREAM")) {
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
  let page = 0;

  while (nextUrl) {
    page++;

    const document = await getJson(nextUrl);

    for (const album of document.data ?? []) {
      if (!ids.includes(album.id)) {
        ids.push(album.id);
      }
    }

    nextUrl = document.links?.next
      ? absoluteTidalUrl(document.links.next)
      : null;

    if (page >= 3) {
      break;
    }
  }

  return ids;
}

async function getAlbum(albumId: string): Promise<any> {
  const url = new URL(`${apiBase}/albums/${albumId}`);
  url.searchParams.set("countryCode", countryCode);

  const document = await getJson(url.toString());
  return document.data;
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

const errorItems = matches
  .filter((row: any) => row.status === "error")
  .map((row: any) => ({
    bandcamp_item_id: row.bandcamp_item_id,
    bandcamp_artist: row.bandcamp_artist,
    bandcamp_title: row.bandcamp_title,
    bandcamp_url: row.bandcamp_url,
  }));

console.log(`Retrying ${errorItems.length} failed items...`);

const updated = new Map<string, any>();

for (let index = 0; index < errorItems.length; index++) {
  const item = errorItems[index];
  const rawTitle = item.bandcamp_title ?? item.title ?? "";

if (!rawTitle) {
  console.log(
    ` → skipping: missing bandcamp_title for ${item.bandcamp_item_id}`
  );
  continue;
}

const cleanedTitle = cleanTitle(rawTitle);

  process.stdout.write(
    `[${index + 1}/${errorItems.length}] ${item.bandcamp_artist} — ${item.bandcamp_title}`
  );

  try {
    const queries = [
      `${item.bandcamp_artist} ${cleanedTitle}`,
      cleanedTitle,
    ];

    const candidateIds = new Set<string>();

    for (const query of queries) {
      for (const id of await searchAlbumIds(query)) {
        candidateIds.add(id);
      }

      await sleep(400);
    }

    const candidates: any[] = [];
    let candidateIndex = 0;

    for (const albumId of candidateIds) {
      candidateIndex++;

      if (candidateIndex > 30) {
        break;
      }

      const album = await getAlbum(albumId);
      const attributes = album.attributes ?? {};

      const titleScore = similarity(
        cleanedTitle,
        attributes.title ?? ""
      );

      const labelHint = normalize(bandcampLabelHint(item.bandcamp_url));
      const copyright = normalize(attributes.copyright?.text ?? "");
      const labelMatches =
        Boolean(labelHint) && copyright.includes(labelHint);

      if (titleScore < 0.5 && !labelMatches) {
        await sleep(300);
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

      await sleep(300);
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    const result = {
      bandcamp_item_id: item.bandcamp_item_id,
      bandcamp_artist: item.bandcamp_artist,
      bandcamp_title: item.bandcamp_title,
      bandcamp_clean_title: cleanedTitle,
      bandcamp_url: item.bandcamp_url,
      bandcamp_label_hint: bandcampLabelHint(item.bandcamp_url),
      status: best
        ? best.score >= 75
          ? "high_confidence"
          : best.score >= 50
            ? "needs_review"
            : "low_confidence"
        : "search_miss",
      best_match: best ?? null,
      candidate_count: candidates.length,
      candidates,
    };

    updated.set(item.bandcamp_item_id, result);

    console.log(
      best
        ? ` → ${best.score} — ${best.tidal_title}`
        : " → no candidates"
    );
  } catch (error) {
    console.log(` → error: ${String(error)}`);

    updated.set(item.bandcamp_item_id, {
      bandcamp_item_id: item.bandcamp_item_id,
      bandcamp_artist: item.bandcamp_artist,
      bandcamp_title: item.bandcamp_title,
      bandcamp_url: item.bandcamp_url,
      status: "error",
      error: String(error),
    });
  }
}

for (const [id, newResult] of updated) {
  const index = matches.findIndex(
    (row: any) => row.bandcamp_item_id === id
  );

  if (index >= 0) {
    matches[index] = newResult;
  }
}

writeFileSync(
  matchesPath,
  JSON.stringify(matches, null, 2),
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
  ...matches.map(row => {
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

console.log("\nFinished.");
console.log(`Updated ${updated.size} items.`);

const finalCounts = matches.reduce((acc: Record<string, number>, row: any) => {
  acc[row.status] = (acc[row.status] ?? 0) + 1;
  return acc;
}, {});

console.log(finalCounts);