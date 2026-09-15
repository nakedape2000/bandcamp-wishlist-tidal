import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./src/config";
import { Terminal } from "./src/terminal";
import { absoluteTidalUrl, asArray, TidalClient } from "./src/tidal";

const config = loadConfig();
const outputDir = process.env.BCTS_OUTPUT_DIR ?? config.storage.output_dir;
const tokenPath =
  process.env.TIDAL_TOKEN_PATH ?? join(outputDir, "tidal-tokens.json");
const jsonPath =
  process.env.BCTS_LIBRARY ?? join(outputDir, "tidal-library.json");
const csvPath =
  process.env.BCTS_LIBRARY_CSV ?? join(outputDir, "tidal-library.csv");
const client = new TidalClient({ tokenPath });
const terminal = new Terminal({
  json: process.argv.includes("--json"),
  quiet: process.argv.includes("--quiet"),
  verbose: process.argv.includes("--verbose"),
  color:
    !process.argv.includes("--no-color") &&
    !process.env.NO_COLOR &&
    process.stderr.isTTY,
});

interface TidalResource {
  id: string;
  type: string;
  meta?: { addedAt?: string };
  attributes?: {
    title?: string;
    releaseDate?: string;
    numberOfItems?: number;
  };
  relationships?: {
    artists?: { data?: TidalResource[] };
    items?: TidalRelationship;
  };
}

interface TidalRelationship {
  data?: TidalResource[];
  links?: { next?: string };
}

interface LibraryAlbum {
  tidal_album_id: string;
  tidal_title: string;
  tidal_release_date: string;
  tidal_added_at: string;
  tidal_artist_ids: string[];
}

function csvEscape(value: unknown): string {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");

  return `"${text.replaceAll('"', '""')}"`;
}

async function exportLibrary(): Promise<LibraryAlbum[]> {
  const initialDocument = await client.get<{
    data?: TidalResource;
    included?: TidalResource[];
  }>(
    `/userCollectionAlbums/me?include=items&countryCode=${encodeURIComponent(config.providers.tidal.country_code)}&locale=${encodeURIComponent(config.providers.tidal.locale)}`,
  );
  const collection = initialDocument.data;

  if (collection?.type !== "userCollectionAlbums") {
    throw new Error("TIDAL did not return a userCollectionAlbums resource.");
  }

  const expectedCount = collection.attributes?.numberOfItems ?? null;
  const itemsRelationship = collection.relationships?.items;

  const firstPageIds = asArray(itemsRelationship?.data);
  const firstPageAlbums = asArray(initialDocument.included).filter(
    (resource) => resource.type === "albums",
  );

  const albums = new Map<string, LibraryAlbum>();
  const addedAtById = new Map<string, string>();

  for (const item of firstPageIds) {
    if (item.type === "albums" && item.id) {
      addedAtById.set(item.id, item.meta?.addedAt ?? "");
    }
  }

  for (const album of firstPageAlbums) {
    albums.set(album.id, {
      tidal_album_id: album.id,
      tidal_title: album.attributes?.title ?? "",
      tidal_release_date: album.attributes?.releaseDate ?? "",
      tidal_added_at: addedAtById.get(album.id) ?? "",
      tidal_artist_ids: asArray(album.relationships?.artists?.data)
        .map((artist) => artist.id)
        .filter(Boolean),
    });
  }

  terminal.debug(
    `Collection reports ${expectedCount ?? "unknown"} albums; first page contains ${albums.size}.`,
  );

  let nextUrl: string | null = itemsRelationship?.links?.next
    ? absoluteTidalUrl(itemsRelationship.links.next)
    : null;

  let page = 1;

  while (nextUrl) {
    page++;

    terminal.progress("Fetching TIDAL library pages", page);

    const document = await client.get<{
      data?: TidalResource[];
      links?: { next?: string };
    }>(nextUrl);
    const pageItems = asArray(document.data);

    terminal.debug(`Page ${page}: ${pageItems.length} album references.`);

    /*
     * Relationship pages normally contain only album linkage:
     *   { id, type, meta: { addedAt } }
     *
     * We only need the album IDs to compare with tidal-matches.json.
     * Therefore do not fetch every album's full metadata here.
     */
    for (const item of pageItems) {
      if (item.type !== "albums" || !item.id) {
        continue;
      }

      if (!albums.has(item.id)) {
        albums.set(item.id, {
          tidal_album_id: item.id,
          tidal_title: "",
          tidal_release_date: "",
          tidal_added_at: item.meta?.addedAt ?? "",
          tidal_artist_ids: [],
        });
      }
    }

    nextUrl = document.links?.next
      ? absoluteTidalUrl(document.links.next)
      : null;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const result = [...albums.values()];

  if (typeof expectedCount === "number" && result.length !== expectedCount) {
    console.warn(
      `Warning: expected ${expectedCount} albums but exported ${result.length}.`,
    );
  }

  return result;
}

terminal.info("Exporting TIDAL library albums...");

const albums = await exportLibrary();

terminal.endProgress();

mkdirSync(outputDir, { recursive: true });
mkdirSync(dirname(jsonPath), { recursive: true });
mkdirSync(dirname(csvPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(albums, null, 2), "utf8");
chmodSync(jsonPath, 0o600);

const columns: Array<keyof LibraryAlbum> = [
  "tidal_album_id",
  "tidal_title",
  "tidal_release_date",
  "tidal_added_at",
  "tidal_artist_ids",
];

const csv = [
  columns.join(","),
  ...albums.map((album) =>
    columns.map((column) => csvEscape(album[column])).join(","),
  ),
].join("\r\n");

writeFileSync(csvPath, csv, "utf8");
chmodSync(csvPath, 0o600);

if (process.env.BCTS_PIPELINE !== "1")
  terminal.output(
    {
      library_count: albums.length,
      json_output: jsonPath,
      csv_output: csvPath,
      provider_writes: 0,
    },
    `Total unique library albums: ${albums.length}\nWrote ${jsonPath}\nWrote ${csvPath}`,
  );
