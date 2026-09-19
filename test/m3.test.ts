import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { ReviewService } from "../src/review";
import {
  createReviewHandler,
  createTidalArtworkResolver,
} from "../src/review-server";
import { SyncStore } from "../src/sync-store";

const databases: Database[] = [];

function serviceWithFixture(
  library: Array<Record<string, unknown>> = [],
): ReviewService {
  const database = new Database(":memory:");
  databases.push(database);
  const store = new SyncStore(database);
  store.importMatches([
    {
      bandcamp_item_id: 7,
      bandcamp_artist: "Fixture Artist",
      bandcamp_title: "Fixture Album",
      bandcamp_label_hint: "fixture label",
      status: "needs_review",
      explanation: "needs_review: title 100%, artist 70%",
      best_match: {
        tidal_album_id: "t1",
        tidal_title: "Fixture Album",
        score: 79,
      },
      candidates: [
        { tidal_album_id: "t1", tidal_title: "Fixture Album", score: 79 },
        { tidal_album_id: "t2", tidal_title: "Other Edition", score: 72 },
      ],
    },
  ]);
  store.importLibrarySnapshot(library);
  return new ReviewService(database);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ReviewService", () => {
  test("lists and filters imported review records with explanations", () => {
    const service = serviceWithFixture();
    expect(
      service.list({ status: "needs_review", artist: "fixture" }),
    ).toHaveLength(1);
    expect(service.get(7)?.explanation).toContain("title 100%");
    expect(service.list({ minScore: 80 })).toEqual([]);
  });

  test("persists approval without performing a provider write", () => {
    const service = serviceWithFixture();
    const decision = service.decide(
      7,
      "approved",
      "t2",
      "2026-09-13T00:00:00.000Z",
    );
    expect(decision.chosenTidalAlbumId).toBe("t2");
    expect(service.pendingWrite()).toHaveLength(1);
    expect(service.get(7)?.decision?.action).toBe("approved");
  });

  test("keeps approved matches visible and classifies saved TIDAL albums", () => {
    const service = serviceWithFixture([{ tidal_album_id: "t1" }]);
    service.decide(7, "approved", "t1", "2026-09-13T00:00:00.000Z");
    expect(service.get(7)).toMatchObject({
      alreadyInTidal: true,
      decision: { action: "approved", chosenTidalAlbumId: "t1" },
    });
    expect(service.pendingWrite()).toEqual([]);
  });

  test("exports and imports portable decisions", () => {
    const source = serviceWithFixture();
    source.decide(7, "deferred", null, "2026-09-13T00:00:00.000Z");
    source.editMetadata(7, { artist: "Corrected Artist" });
    const document = source.exportDecisions("2026-09-13T01:00:00.000Z");
    const target = serviceWithFixture();
    expect(target.importDecisions(document)).toBe(1);
    expect(target.get(7)?.decision?.metadata.artist).toBe("Corrected Artist");
  });

  test("rolls back imported decisions when a later item fails", () => {
    const service = serviceWithFixture();
    expect(() =>
      service.importDecisions({
        schema_version: 1,
        exported_at: "2026-09-13T01:00:00.000Z",
        decisions: [
          {
            bandcampItemId: 7,
            action: "deferred",
            chosenTidalAlbumId: null,
            metadata: {},
            updatedAt: "2026-09-13T01:00:00.000Z",
          },
          {
            bandcampItemId: 999,
            action: "deferred",
            chosenTidalAlbumId: null,
            metadata: {},
            updatedAt: "2026-09-13T01:00:00.000Z",
          },
        ],
      }),
    ).toThrow("Review item 999 not found.");
    expect(service.get(7)?.decision).toBeNull();
  });

  test("validates metadata and keeps edited values durable", () => {
    const service = serviceWithFixture();
    service.editMetadata(7, { artist: "  Corrected Artist  " });
    expect(service.get(7)?.artist).toBe("Corrected Artist");
    expect(service.get(7)?.decision).toBeNull();
    expect(service.exportDecisions().metadata_overrides).toHaveLength(1);
    expect(() => service.editMetadata(7, { unexpected: "value" })).toThrow(
      "Metadata may only contain",
    );
  });

  test("rejects a selected alternate candidate", () => {
    const service = serviceWithFixture();
    service.decide(7, "rejected", "t2", "2026-09-13T00:00:00.000Z");
    const database = databases.at(-1) as Database;
    expect(
      database
        .query(
          "SELECT tidal_album_id FROM negative_decisions WHERE bandcamp_item_id = 7",
        )
        .get(),
    ).toEqual({ tidal_album_id: "t2" });
  });

  test("works with an empty database", () => {
    const database = new Database(":memory:");
    databases.push(database);
    expect(new ReviewService(database).list()).toEqual([]);
  });

  test("exposes an empty review API without credentials", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    const handler = createReviewHandler(
      new ReviewService(database),
      "session-token",
      "csrf-token",
    );
    const response = await handler(
      new Request("http://127.0.0.1/api/reviews", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ records: [], total: 0 });
  });

  test("rejects requests with an unlisted host", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    const handler = createReviewHandler(
      new ReviewService(database),
      "session-token",
      "csrf-token",
    );
    const response = await handler(
      new Request("http://127.0.0.1/api/session", {
        headers: { Host: "attacker.example:4173" },
      }),
    );
    expect(response.status).toBe(421);
  });

  test("accepts a loopback host with its port", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    const handler = createReviewHandler(
      new ReviewService(database),
      "session-token",
      "csrf-token",
    );
    const response = await handler(
      new Request("http://127.0.0.1:4173/api/session", {
        headers: { Host: "127.0.0.1:4173" },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("canonicalizes an explicit host allowlist with a port", async () => {
    const database = new Database(":memory:");
    databases.push(database);
    const handler = createReviewHandler(
      new ReviewService(database),
      "session-token",
      "csrf-token",
      undefined,
      ["127.0.0.1:4173"],
    );
    const response = await handler(
      new Request("http://127.0.0.1:4173/api/session", {
        headers: { Host: "127.0.0.1:4173" },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("requires the session cookie and CSRF token for decisions", async () => {
    const service = serviceWithFixture();
    const handler = createReviewHandler(service, "session-token", "csrf-token");
    const unauthorized = await handler(
      new Request("http://127.0.0.1/api/reviews/7", {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "127.0.0.1" },
        body: JSON.stringify({ action: "approved", candidateId: "t1" }),
      }),
    );
    expect(unauthorized.status).toBe(403);
    expect(service.get(7)?.decision).toBeNull();

    const session = await handler(
      new Request("http://127.0.0.1/api/session", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(session.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await session.json()).toEqual({ csrfToken: "csrf-token" });

    const authorized = await handler(
      new Request("http://127.0.0.1/api/reviews/7", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "127.0.0.1",
          Cookie: "bcts_session=session-token",
          "X-CSRF-Token": "csrf-token",
        },
        body: JSON.stringify({ action: "approved", candidateId: "t1" }),
      }),
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ providerWrites: 0 });
    expect(service.pendingPlan()).toMatchObject({
      additionCount: 1,
      providerWrites: 0,
    });
  });

  test("resolves public TIDAL artwork without account credentials", async () => {
    let requests = 0;
    const resolver = createTidalArtworkResolver(async () => {
      requests++;
      return new Response(
        '<meta property="og:image" content="https://resources.tidal.com/images/fixture/640x640.jpg">',
      );
    });
    expect(await resolver("t1")).toBe(
      "https://resources.tidal.com/images/fixture/640x640.jpg",
    );
    expect(await resolver("t1")).toContain("resources.tidal.com");
    expect(requests).toBe(1);
  });
});
