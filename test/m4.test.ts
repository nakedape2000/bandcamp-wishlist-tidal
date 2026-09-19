import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { ReviewService } from "../src/review";
import { SyncStore } from "../src/sync-store";
import {
  buildWritePlan,
  hashResponseBody,
  numberedPlanBatches,
  persistWritePlan,
  planBatches,
} from "../src/write-orchestrator";

const databases: Database[] = [];

function prepared(): {
  database: Database;
  reviews: ReviewService;
  store: SyncStore;
} {
  const database = new Database(":memory:");
  databases.push(database);
  const store = new SyncStore(database);
  store.importMatches([
    {
      bandcamp_item_id: 7,
      bandcamp_artist: "Artist",
      bandcamp_title: "Album",
      bandcamp_url: "https://artist.bandcamp.com/album/album",
      status: "needs_review",
      best_match: {
        tidal_album_id: "t1",
        tidal_title: "Album",
        tidal_artists: ["Artist"],
        score: 91,
        tidal_url: "https://tidal.com/browse/album/t1",
      },
      candidates: [
        {
          tidal_album_id: "t1",
          tidal_title: "Album",
          tidal_artists: ["Artist"],
          score: 91,
        },
      ],
    },
  ]);
  store.importLibrarySnapshot([]);
  const reviews = new ReviewService(database);
  reviews.decide(7, "approved", "t1", "2026-09-13T00:00:00.000Z");
  return { database, reviews, store };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("write orchestration", () => {
  test("creates an immutable, inspectable plan", () => {
    const { reviews, store } = prepared();
    const plan = buildWritePlan(
      reviews,
      {
        ...defaultConfig(),
        sync: { ...defaultConfig().sync, max_additions_per_run: 10 },
      },
      "2026-09-13T01:00:00.000Z",
    );
    expect(plan.additionCount).toBe(1);
    persistWritePlan(store, plan);
    expect(store.getWritePlan(plan.planId)?.status).toBe("proposed");
    expect(() => persistWritePlan(store, plan)).toThrow(/immutable/i);
  });

  test("rolls back a write plan when an item violates uniqueness", () => {
    const { store } = prepared();
    expect(() =>
      store.createWritePlan({
        planId: "duplicate-plan",
        createdAt: "2026-09-13T01:00:00.000Z",
        provider: "tidal",
        collection: "me",
        maxAdditions: 10,
        items: [
          { bandcampItemId: 7, tidalAlbumId: "t1", source: { position: 0 } },
          { bandcampItemId: 8, tidalAlbumId: "t1", source: { position: 1 } },
        ],
        payload: { planId: "duplicate-plan" },
      }),
    ).toThrow();
    expect(store.getWritePlan("duplicate-plan")).toBeNull();
  });

  test("derives stable batches and idempotency keys", () => {
    const { reviews } = prepared();
    const plan = buildWritePlan(
      reviews,
      defaultConfig(),
      "2026-09-13T01:00:00.000Z",
    );
    const batches = planBatches(plan, 1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.payload.data).toEqual([{ id: "t1", type: "albums" }]);
    expect(batches[0]?.idempotencyKey).toBe(
      planBatches(plan, 1)[0]?.idempotencyKey,
    );
  });

  test("keeps original batch numbers when earlier batches are already live", () => {
    const { reviews } = prepared();
    const single = buildWritePlan(
      reviews,
      defaultConfig(),
      "2026-09-13T01:00:00.000Z",
    ).items[0];
    if (!single) throw new Error("Fixture plan item is missing");
    const plan = {
      ...buildWritePlan(reviews, defaultConfig(), "2026-09-13T01:00:00.000Z"),
      items: ["a", "b", "c", "d"].map((tidalAlbumId, index) => ({
        ...single,
        bandcampItemId: index + 1,
        tidalAlbumId,
      })),
      additionCount: 4,
    };
    const live = new Set(["a", "b"]);
    const remaining = numberedPlanBatches(plan, 2).filter((batch) =>
      batch.albumIds.some((id) => !live.has(id)),
    );
    expect(
      remaining.map((batch) => [batch.batchNumber, batch.albumIds]),
    ).toEqual([[2, ["c", "d"]]]);
  });

  test("hashes response bodies for an audit trail", () => {
    expect(hashResponseBody("ok")).toHaveLength(64);
    expect(hashResponseBody("ok")).not.toBe(hashResponseBody("error"));
  });
});
