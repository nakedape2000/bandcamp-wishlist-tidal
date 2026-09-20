import type { AppConfig } from "../config";
import { summarizeToken } from "../oauth";
import {
  type CollectionVerification,
  type DestinationCapability,
  type DestinationProvider,
  PROVIDER_CONTRACT_VERSION,
  type ProviderAlbum,
  type ProviderAuthorizationStatus,
  type ProviderWriteResult,
  requireCapability,
  type VerificationOptions,
} from "../provider-contract";
import { readTokenFile } from "../secrets";
import {
  absoluteTidalUrl,
  asArray,
  fetchTidalLibraryIds,
  TidalClient,
  tidalClientOptionsFromConfig,
  verifyTidalLibraryIds,
} from "../tidal";

interface TidalTransport {
  get<T>(pathOrUrl: string): Promise<T>;
  post<T>(
    pathOrUrl: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ status: number; body: T }>;
}

interface TidalSearchPage {
  data?: Array<{ id?: string }>;
  links?: { next?: string | null };
}

interface TidalAlbumDocument {
  data?: {
    id?: string;
    attributes?: {
      title?: string;
      releaseDate?: string;
      numberOfItems?: number;
      imageLinks?: Array<{ href?: string }>;
    };
  };
}

interface TidalArtistsDocument {
  included?: Array<{ type?: string; attributes?: { name?: string } }>;
}

/** TIDAL's route and JSON:API details stay contained in this adapter. */
export class TidalDestinationAdapter implements DestinationProvider {
  readonly id = "tidal";
  readonly contractVersion = PROVIDER_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<DestinationCapability> = new Set([
    "catalogue-search",
    "collection-read",
    "collection-write",
    "authorization-status",
  ]);

  constructor(
    private readonly client: TidalTransport,
    private readonly tokenPath: string,
  ) {}

  async authorizationStatus(): Promise<ProviderAuthorizationStatus> {
    try {
      const summary = summarizeToken(await readTokenFile(this.tokenPath));
      return {
        configured: summary.configured,
        expired: summary.expired,
        missingScopes: summary.missing_scopes,
        detail: summary.expired
          ? "TIDAL token is expired. Reauthorize TIDAL."
          : summary.missing_scopes.length
            ? `TIDAL token is missing scopes: ${summary.missing_scopes.join(", ")}.`
            : "TIDAL token is ready.",
      };
    } catch {
      return {
        configured: false,
        expired: null,
        missingScopes: [],
        detail: "TIDAL is not authorized on this machine.",
      };
    }
  }

  async searchAlbums(query: string): Promise<ProviderAlbum[]> {
    requireCapability(this, "catalogue-search");
    const trimmed = query.trim();
    if (!trimmed) return [];
    const search = await this.client.get<TidalSearchPage>(
      `/searchResults?filter[query]=${encodeURIComponent(trimmed)}`,
    );
    const searchId = search.data?.[0]?.id;
    if (!searchId) return [];
    const ids: string[] = [];
    let next: string | null =
      `/searchResults/${encodeURIComponent(searchId)}/relationships/albums`;
    while (next && ids.length < 30) {
      const page: TidalSearchPage =
        await this.client.get<TidalSearchPage>(next);
      for (const item of asArray(page.data)) {
        if (item.id && !ids.includes(item.id)) ids.push(item.id);
        if (ids.length === 30) break;
      }
      next = page.links?.next ? absoluteTidalUrl(page.links.next) : null;
    }
    return Promise.all(ids.map((id) => this.album(id)));
  }

  async readCollectionAlbumIds(collection: string): Promise<Set<string>> {
    requireCapability(this, "collection-read");
    this.requireMyCollection(collection);
    return fetchTidalLibraryIds(this.client);
  }

  async addAlbums(
    collection: string,
    albumIds: readonly string[],
    idempotencyKey: string,
  ): Promise<ProviderWriteResult> {
    requireCapability(this, "collection-write");
    this.requireMyCollection(collection);
    if (!idempotencyKey) throw new Error("An idempotency key is required.");
    const ids = [...new Set(albumIds.map(String))];
    const result = await this.client.post(
      "/userCollectionAlbums/me/relationships/items",
      { data: ids.map((id) => ({ id, type: "albums" })) },
      idempotencyKey,
    );
    return { status: result.status, responseBody: result.body };
  }

  async verifyCollectionAlbumIds(
    collection: string,
    requiredIds: Iterable<string>,
    options?: VerificationOptions,
  ): Promise<CollectionVerification> {
    requireCapability(this, "collection-read");
    this.requireMyCollection(collection);
    return verifyTidalLibraryIds(this.client, requiredIds, options);
  }

  private async album(id: string): Promise<ProviderAlbum> {
    const [document, artistsDocument] = await Promise.all([
      this.client.get<TidalAlbumDocument>(`/albums/${encodeURIComponent(id)}`),
      this.client.get<TidalArtistsDocument>(
        `/albums/${encodeURIComponent(id)}/relationships/artists?include=artists`,
      ),
    ]);
    const attributes = document.data?.attributes;
    return {
      id,
      title: attributes?.title ?? "",
      artists: (artistsDocument.included ?? [])
        .filter((entry) => entry.type === "artists")
        .map((entry) => entry.attributes?.name)
        .filter((name): name is string => Boolean(name)),
      url: `https://tidal.com/browse/album/${encodeURIComponent(id)}`,
      artworkUrl: attributes?.imageLinks?.find((link) => link.href)?.href,
      releaseDate: attributes?.releaseDate,
      trackCount: attributes?.numberOfItems,
    };
  }

  private requireMyCollection(collection: string): void {
    if (collection !== "me")
      throw new Error(
        `TIDAL only supports the "me" collection, received "${collection}".`,
      );
  }
}

export function createTidalDestinationAdapter(
  config: AppConfig,
): TidalDestinationAdapter {
  const options = tidalClientOptionsFromConfig(config);
  return new TidalDestinationAdapter(
    new TidalClient(options),
    options.tokenPath ?? "./output/tidal-tokens.json",
  );
}
