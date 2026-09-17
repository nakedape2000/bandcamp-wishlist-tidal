import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./src/config";
import { MatchCache } from "./src/match-cache";
import { detectDuplicateEditions, scoreMatch } from "./src/matching";
import { SyncStore } from "./src/sync-store";
import { Terminal } from "./src/terminal";

interface WishlistAlbum {
  itemId: number;
  itemType: string;
  artist: string;
  title: string;
  url: string;
}

interface AlbumResource {
  id: string;
  attributes?: {
    title?: string;
    releaseDate?: string;
    numberOfItems?: number;
    copyright?: { text?: string };
    albumType?: string;
    availability?: string[];
  };
}

interface ScanCandidate {
  tidal_album_id: string;
  tidal_title: string;
  tidal_artists: string[];
  tidal_release_date: string;
  tidal_track_count: number | null;
  tidal_copyright: string;
  tidal_album_type: string;
  tidal_availability: string[];
  tidal_url: string;
  score: number;
  status: string;
  explanation: string;
  signals: unknown;
}

interface ScanResult {
  bandcamp_item_id: number;
  bandcamp_artist: string;
  bandcamp_title: string;
  bandcamp_clean_title?: string;
  bandcamp_url: string;
  bandcamp_label_hint?: string;
  status: string;
  best_match?: ScanCandidate | null;
  explanation?: string;
  duplicate_editions?: unknown;
  candidate_count?: number;
  candidates?: ScanCandidate[];
  error?: string;
}

interface AlbumRelationshipDocument {
  data?: Array<{ id: string }>;
  links?: { next?: string };
}

const scanConfig = loadConfig();
const terminal = new Terminal({
  json: process.argv.includes("--json"),
  quiet: process.argv.includes("--quiet"),
  verbose: process.argv.includes("--verbose"),
  color:
    !process.argv.includes("--no-color") &&
    !process.env.NO_COLOR &&
    process.stderr.isTTY,
});
const outputDir = process.env.BCTS_OUTPUT_DIR ?? scanConfig.storage.output_dir;
const tokenPath =
  process.env.TIDAL_TOKEN_PATH ?? join(outputDir, "tidal-tokens.json");
const wishlistPath =
  process.env.BCTS_WISHLIST_SNAPSHOT ?? join(outputDir, "wishlist.json");
const matchesJsonPath =
  process.env.BCTS_MATCHES ?? join(outputDir, "tidal-matches.json");
const matchesCsvPath =
  process.env.BCTS_MATCHES_CSV ?? join(outputDir, "tidal-matches.csv");
const tokenData = JSON.parse(readFileSync(tokenPath, "utf8")) as {
  access_token?: string;
};
const wishlistData = JSON.parse(readFileSync(wishlistPath, "utf8")) as {
  items: WishlistAlbum[];
};
const forceFullScan =
  process.argv.includes("--full") || process.argv.includes("--full-rescan");
const previousMatches = new Map<number, ScanResult>();
if (!forceFullScan && existsSync(matchesJsonPath)) {
  try {
    const cached = JSON.parse(readFileSync(matchesJsonPath, "utf8")) as unknown;
    if (Array.isArray(cached)) {
      for (const entry of cached) {
        const result = entry as ScanResult;
        if (Number.isFinite(result.bandcamp_item_id))
          previousMatches.set(result.bandcamp_item_id, result);
      }
    }
  } catch {
    // A malformed prior report is treated as a cache miss; the fresh scan will replace it.
  }
}

const accessToken = tokenData.access_token;
const countryCode = scanConfig.providers.tidal.country_code;
const apiBase = "https://openapi.tidal.com/v2";
const testOnly = false;
const testItemLimit = 5;
const maxCandidates = 30;
const cacheDatabasePath =
  process.env.BCTS_DATABASE ?? scanConfig.storage.database;
mkdirSync(dirname(cacheDatabasePath), { recursive: true });
const cacheDatabase = new Database(cacheDatabasePath);
const matchCache = new MatchCache(cacheDatabase);
const syncStore = new SyncStore(cacheDatabase);
const cacheTtlMs = Number(
  process.env.BCTS_MATCH_CACHE_TTL_MS ??
    scanConfig.matching.cache_ttl_days * 24 * 60 * 60 * 1000,
);

if (!accessToken) {
  throw new Error(`Missing access_token in ${tokenPath}`);
}

const headers = {
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/vnd.api+json",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequestAt = 0;

async function paceRequest(): Promise<void> {
  const waitMs = Math.max(0, 250 - (Date.now() - lastRequestAt));
  if (waitMs) await sleep(waitMs);
  lastRequestAt = Date.now();
}

async function getJson<T>(url: string, attempt = 1): Promise<T> {
  terminal.debug(`GET ${url}`);
  await paceRequest();

  let response: Response;

  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (attempt <= 3) {
      const message = error instanceof Error ? error.message : String(error);
      terminal.debug(`Request failed: ${message}`);
      terminal.info(`Retrying request (${attempt + 1}/3)...`);
      await sleep(attempt * 2500);
      return getJson<T>(url, attempt + 1);
    }

    throw new Error(`Request timed out or failed: ${url}`);
  }

  const text = await response.text();

  if (response.status === 429) {
    if (attempt <= 5) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : attempt * 5000;

      terminal.info(`TIDAL rate limit reached; retrying in ${waitMs} ms.`);
      await sleep(waitMs);
      return getJson<T>(url, attempt + 1);
    }

    throw new Error("HTTP 429: rate limit retries exhausted");
  }

  if (response.status >= 500 && attempt <= 4) {
    terminal.info(`TIDAL returned HTTP ${response.status}; retrying...`);
    await sleep(attempt * 3000);
    return getJson<T>(url, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return JSON.parse(text) as T;
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
  const intersection = [...leftWords].filter((word) => rightWords.has(word));

  return intersection.length / Math.max(leftWords.size, rightWords.size);
}

async function searchAlbumIds(query: string): Promise<string[]> {
  const cacheKey = `tidal-search:${countryCode}:${query.toLowerCase().trim()}`;
  const cached = matchCache.get<string[]>(cacheKey, cacheTtlMs);
  if (cached) return cached.value;
  const searchUrl = new URL(`${apiBase}/searchResults`);
  searchUrl.searchParams.set("countryCode", countryCode);
  searchUrl.searchParams.set("filter[query]", query);

  const searchDocument = await getJson<{ data?: Array<{ id: string }> }>(
    searchUrl.toString(),
  );
  const searchResultId = searchDocument.data?.[0]?.id;

  if (!searchResultId) return [];

  let nextUrl: string | null =
    `${apiBase}/searchResults/${searchResultId}/relationships/albums?countryCode=${countryCode}`;

  const ids: string[] = [];

  while (nextUrl && ids.length < maxCandidates) {
    const page: AlbumRelationshipDocument =
      await getJson<AlbumRelationshipDocument>(nextUrl);

    for (const album of page.data ?? []) {
      if (!ids.includes(album.id)) {
        ids.push(album.id);
      }

      if (ids.length >= maxCandidates) break;
    }

    nextUrl = page.links?.next ? resolveTidalUrl(page.links.next) : null;
  }

  matchCache.set(cacheKey, ids);
  return ids;
}

async function getAlbum(albumId: string): Promise<AlbumResource> {
  const cached = matchCache.get<AlbumResource>(
    `tidal-album:${countryCode}:${albumId}`,
    cacheTtlMs,
  );
  if (cached) return cached.value;
  const url = new URL(`${apiBase}/albums/${albumId}`);
  url.searchParams.set("countryCode", countryCode);
  const album = (await getJson<{ data: AlbumResource }>(url.toString())).data;
  matchCache.set(`tidal-album:${countryCode}:${albumId}`, album);
  return album;
}

async function getAlbumArtists(albumId: string): Promise<string[]> {
  const cacheKey = `tidal-artists:${countryCode}:${albumId}`;
  const cached = matchCache.get<string[]>(cacheKey, cacheTtlMs);
  if (cached) return cached.value;
  const url = new URL(`${apiBase}/albums/${albumId}/relationships/artists`);

  url.searchParams.set("countryCode", countryCode);
  url.searchParams.set("include", "artists");

  const document = await getJson<{
    included?: Array<{ type?: string; attributes?: { name?: string } }>;
  }>(url.toString());

  const artists = (document.included ?? [])
    .filter((entry) => entry.type === "artists")
    .map((entry) => entry.attributes?.name)
    .filter((name): name is string => Boolean(name));
  matchCache.set(cacheKey, artists);
  return artists;
}

const allItems = wishlistData.items.filter((item) => item.itemType === "album");

const items = testOnly ? allItems.slice(0, testItemLimit) : allItems;
const output: ScanResult[] = [];
let reusedCount = 0;
let scannedCount = 0;

for (let index = 0; index < items.length; index++) {
  const item = items[index] as WishlistAlbum;
  const cleanedTitle = cleanTitle(item.title);

  const cached = previousMatches.get(item.itemId);
  if (
    cached &&
    cached.status !== "error" &&
    cached.bandcamp_artist === item.artist &&
    cached.bandcamp_title === item.title &&
    cached.bandcamp_url === item.url
  ) {
    output.push(cached);
    reusedCount++;
    terminal.progress("Reusing cached matches", reusedCount, items.length);
    continue;
  }

  terminal.progress("Matching albums", index + 1, items.length);
  scannedCount++;
  terminal.debug(`${item.artist} - ${item.title}`);

  try {
    const queries = [`${item.artist} ${cleanedTitle}`, cleanedTitle];

    const candidateIds = new Set<string>();

    for (const query of queries) {
      for (const id of await searchAlbumIds(query)) {
        if (!syncStore.isRejected(item.itemId, id)) candidateIds.add(id);
        if (candidateIds.size >= maxCandidates) break;
      }

      if (candidateIds.size >= maxCandidates) break;
    }

    const candidates: ScanCandidate[] = [];
    let candidateIndex = 0;

    for (const albumId of candidateIds) {
      candidateIndex++;
      terminal.debug(
        `Candidate ${candidateIndex}/${candidateIds.size}: ${albumId}`,
      );

      const album = await getAlbum(albumId);
      const attributes = album.attributes ?? {};
      const titleScore = similarity(cleanedTitle, attributes.title ?? "");

      if (titleScore < 0.5) {
        continue;
      }

      const artists = await getAlbumArtists(albumId);
      const matchEvidence = scoreMatch(
        {
          artist: item.artist,
          title: cleanedTitle,
          label: bandcampLabelHint(item.url),
        },
        {
          id: albumId,
          artist: artists.join(" "),
          title: attributes.title ?? "",
          label: attributes.copyright?.text ?? "",
        },
        {},
        {
          high: scanConfig.matching.high_confidence_threshold * 100,
          review: scanConfig.matching.review_threshold * 100,
        },
      );
      const score = matchEvidence.score;

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
        status: matchEvidence.status,
        explanation: matchEvidence.explanation,
        signals: matchEvidence.signals,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] ?? null;
    const duplicateEditions = detectDuplicateEditions(
      candidates.map((candidate) => ({
        id: String(candidate.tidal_album_id),
        artist: candidate.tidal_artists.join(" "),
        title: candidate.tidal_title,
      })),
    );

    output.push({
      bandcamp_item_id: item.itemId,
      bandcamp_artist: item.artist,
      bandcamp_title: item.title,
      bandcamp_clean_title: cleanedTitle,
      bandcamp_url: item.url,
      bandcamp_label_hint: bandcampLabelHint(item.url),
      status: best?.status ?? "search_miss",
      best_match: best,
      explanation: best?.explanation ?? "search_miss: no plausible candidates",
      duplicate_editions: duplicateEditions,
      candidate_count: candidates.length,
      candidates,
    });

    terminal.debug(
      best
        ? `Best: ${best.score} - ${best.tidal_title}`
        : "No plausible candidates",
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

    terminal.info(
      `Match error for ${item.artist} - ${item.title}: ${String(error)}`,
    );
  }
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(matchesJsonPath, JSON.stringify(output, null, 2), "utf8");

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
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");

  return `"${text.replaceAll('"', '""')}"`;
}

const csvRows = [
  csvColumns.join(","),
  ...output.map((row) => {
    const best = row.best_match;

    return [
      row.bandcamp_item_id,
      row.bandcamp_artist,
      row.bandcamp_title,
      row.bandcamp_clean_title,
      row.bandcamp_url,
      row.bandcamp_label_hint,
      row.status,
      row.candidate_count,
      best?.tidal_album_id,
      best?.tidal_title,
      best?.tidal_artists,
      best?.tidal_release_date,
      best?.tidal_track_count,
      best?.tidal_copyright,
      best?.tidal_album_type,
      best?.tidal_availability,
      best?.score,
      best?.tidal_url,
    ]
      .map(csvEscape)
      .join(",");
  }),
];

writeFileSync(matchesCsvPath, csvRows.join("\r\n"), "utf8");

terminal.endProgress();
if (process.env.BCTS_PIPELINE !== "1")
  terminal.output(
    {
      result_count: output.length,
      reused_count: reusedCount,
      scanned_count: scannedCount,
      json_output: matchesJsonPath,
      csv_output: matchesCsvPath,
      provider_writes: 0,
    },
    `Finished. Wrote ${output.length} results.\nWrote ${matchesJsonPath}\nWrote ${matchesCsvPath}`,
  );
cacheDatabase.close();
