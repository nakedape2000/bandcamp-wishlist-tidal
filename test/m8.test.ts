import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { requestJson } from "../src/http";
import {
  type DestinationProvider,
  PROVIDER_CONTRACT_VERSION,
  providerConfigNamespace,
  requireCapability,
} from "../src/provider-contract";
import { destinationProviderFor } from "../src/providers";
import { BandcampSourceAdapter } from "../src/providers/bandcamp-source-adapter";
import { TidalDestinationAdapter } from "../src/providers/tidal-adapter";
import { SyncStore } from "../src/sync-store";
import { tidalClientOptionsFromConfig } from "../src/tidal";

const fixture = JSON.parse(
  readFileSync("test/fixtures/providers/tidal/contract.json", "utf8"),
) as Record<string, unknown>;

class FixtureTransport {
  readonly requests: string[] = [];
  readonly writes: Array<{ path: string; body: unknown; key: string }> = [];

  async get<T>(path: string): Promise<T> {
    this.requests.push(path);
    if (path.startsWith("/searchResults?")) return fixture.search as T;
    if (path === "/searchResults/search-1/relationships/albums")
      return fixture.searchAlbumsPage1 as T;
    if (path.includes("/search-page-2")) return fixture.searchAlbumsPage2 as T;
    if (path === "/albums/album-1") return fixture.album1 as T;
    if (path === "/albums/album-2") return fixture.album2 as T;
    if (path.startsWith("/albums/album-1/relationships/artists"))
      return fixture.artists1 as T;
    if (path.startsWith("/albums/album-2/relationships/artists"))
      return fixture.artists2 as T;
    if (path === "/userCollectionAlbums/me?include=items")
      return fixture.collectionFirst as T;
    if (path.includes("/collection-page-2"))
      return fixture.collectionSecond as T;
    throw new Error(`Unexpected fixture request: ${path}`);
  }

  async post<T>(path: string, body: unknown, key: string) {
    this.writes.push({ path, body, key });
    return { status: 204, body: fixture.write as T };
  }
}

function tidalFixture(): {
  adapter: TidalDestinationAdapter;
  transport: FixtureTransport;
} {
  const transport = new FixtureTransport();
  return {
    adapter: new TidalDestinationAdapter(transport, "/definitely-not-a-token"),
    transport,
  };
}

describe("M8 provider contract", () => {
  test("uses stable provider identifiers, namespaces, and contract version", () => {
    expect(PROVIDER_CONTRACT_VERSION).toBe(1);
    expect(providerConfigNamespace("bandcamp")).toBe("providers.bandcamp");
    expect(providerConfigNamespace("tidal")).toBe("providers.tidal");
    expect(() => providerConfigNamespace("not valid")).toThrow(
      /invalid provider id/i,
    );
  });

  test("Bandcamp source adapter returns a normalized wishlist", async () => {
    const progress: number[] = [];
    const source = new BandcampSourceAdapter(
      {
        resolveFanId: async () => 42,
        fetchAllWishlistItems: async (_fanId, _count, onProgress) => {
          onProgress?.(1);
          return [
            {
              itemId: 1,
              itemType: "album",
              artist: "Fixture Artist",
              title: "Fixture Album",
              url: "https://fixture.bandcamp.com/album/fixture",
              artUrl: null,
              addedAt: null,
            },
          ];
        },
      },
      () => new Date("2026-09-19T00:00:00.000Z"),
    );
    await expect(
      source.fetchWishlist("fixture", {
        onProgress: progress.push.bind(progress),
      }),
    ).resolves.toMatchObject({
      providerId: "bandcamp",
      fanId: 42,
      items: [{ itemId: 1 }],
    });
    expect(source.contractVersion).toBe(PROVIDER_CONTRACT_VERSION);
    expect(source.capabilities).toEqual(new Set(["wishlist-read"]));
    expect(progress).toEqual([1]);
  });

  test("TIDAL adapter uses configured account settings and token path", () => {
    const config = defaultConfig();
    config.storage.output_dir = join(tmpdir(), "bcts-configured-output");
    config.providers.tidal.country_code = "NL";
    config.providers.tidal.locale = "nl-NL";
    expect(tidalClientOptionsFromConfig(config, {})).toEqual({
      tokenPath: join(tmpdir(), "bcts-configured-output", "tidal-tokens.json"),
      countryCode: "NL",
      locale: "nl-NL",
    });
    expect(
      tidalClientOptionsFromConfig(config, {
        TIDAL_TOKEN_PATH: join(tmpdir(), "explicit-token.json"),
      }).tokenPath,
    ).toBe(join(tmpdir(), "explicit-token.json"));
  });

  test("TIDAL adapter normalizes search results and follows pagination", async () => {
    const { adapter } = tidalFixture();
    await expect(adapter.searchAlbums("fixture")).resolves.toEqual([
      expect.objectContaining({
        id: "album-1",
        title: "Fixture One",
        artists: ["Fixture Artist"],
        trackCount: 8,
      }),
      expect.objectContaining({ id: "album-2", artists: ["Another Artist"] }),
    ]);
  });

  test("TIDAL adapter reads a paginated collection and verifies it", async () => {
    const { adapter } = tidalFixture();
    await expect(adapter.readCollectionAlbumIds("me")).resolves.toEqual(
      new Set(["album-1", "album-2"]),
    );
    await expect(
      adapter.verifyCollectionAlbumIds("me", ["album-1", "missing"], {
        attempts: 1,
      }),
    ).resolves.toMatchObject({ missing: ["missing"], attempts: 1 });
  });

  test("TIDAL writes retain an idempotency key and surface unknown outcomes", async () => {
    const { adapter, transport } = tidalFixture();
    await expect(
      adapter.addAlbums("me", ["album-1", "album-1"], "key-1"),
    ).resolves.toMatchObject({
      status: 204,
    });
    expect(transport.writes).toEqual([
      {
        path: "/userCollectionAlbums/me/relationships/items",
        body: { data: [{ id: "album-1", type: "albums" }] },
        key: "key-1",
      },
    ]);
    const failing = new TidalDestinationAdapter(
      {
        get: transport.get.bind(transport),
        post: async () => Promise.reject(new Error("connection lost")),
      },
      "/definitely-not-a-token",
    );
    await expect(failing.addAlbums("me", ["album-1"], "key-2")).rejects.toThrow(
      "connection lost",
    );
  });

  test("unavailable capabilities stop before a write endpoint", () => {
    let writes = 0;
    const provider = {
      id: "read-only-fixture",
      contractVersion: PROVIDER_CONTRACT_VERSION,
      capabilities: new Set(["collection-read"]),
      authorizationStatus: async () => ({
        configured: true,
        expired: false,
        missingScopes: [],
        detail: "ready",
      }),
      searchAlbums: async () => [],
      readCollectionAlbumIds: async () => new Set<string>(),
      addAlbums: async () => {
        writes++;
        return { status: 204, responseBody: null };
      },
      verifyCollectionAlbumIds: async () => ({
        ids: new Set<string>(),
        missing: [],
        attempts: 1,
      }),
    } satisfies DestinationProvider;
    expect(() => requireCapability(provider, "collection-write")).toThrow(
      /does not support collection-write.*No provider request was made/i,
    );
    expect(writes).toBe(0);
  });

  test("unknown built-in providers fail before a write can be attempted", () => {
    expect(() =>
      destinationProviderFor("future-fixture", defaultConfig()),
    ).toThrow(/not configured.*No provider write was made/i);
  });

  test("authorization is clear without a local token", async () => {
    const { adapter } = tidalFixture();
    await expect(adapter.authorizationStatus()).resolves.toMatchObject({
      configured: false,
      detail: "TIDAL is not authorized on this machine.",
    });
  });

  test("existing TIDAL plans, snapshots, and audit records remain readable", () => {
    const database = new Database(":memory:");
    try {
      const store = new SyncStore(database);
      store.importLibrarySnapshot([{ tidal_album_id: "album-1" }]);
      store.createWritePlan({
        planId: "tidal-legacy-plan",
        createdAt: "2026-09-19T00:00:00.000Z",
        provider: "tidal",
        collection: "me",
        maxAdditions: 1,
        items: [
          {
            bandcampItemId: 1,
            tidalAlbumId: "album-2",
            source: { title: "Legacy fixture" },
          },
        ],
        payload: { provider: "tidal", schemaVersion: 1 },
      });
      store.recordWriteAttempt({
        planId: "tidal-legacy-plan",
        batchNumber: 1,
        idempotencyKey: "legacy-key",
        payload: { data: [{ id: "album-2", type: "albums" }] },
        startedAt: "2026-09-19T00:00:00.000Z",
        status: "success",
        responseStatus: 204,
      });
      expect(store.summary().library_snapshots).toBe(1);
      expect(store.getWritePlan("tidal-legacy-plan")).toMatchObject({
        provider: "tidal",
        collection: "me",
      });
      expect(store.listWriteAttempts("tidal-legacy-plan")).toMatchObject([
        { batch_number: 1, status: "success", response_status: 204 },
      ]);
    } finally {
      database.close();
    }
  });

  test("retryable HTTP errors are retried without a provider write", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts === 1
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        requestJson<{ ok: boolean }>(
          "https://provider.invalid/fixture",
          {},
          { retries: 1, baseDelayMs: 0 },
        ),
      ).resolves.toEqual({ ok: true });
      expect(attempts).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
