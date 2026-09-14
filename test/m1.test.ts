import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SyncStore } from "../src/sync-store";
import type { WishlistItem } from "../src/types";

const databases: Database[] = [];

function item(itemId: number, title = `Album ${itemId}`): WishlistItem {
  return {
    itemId,
    itemType: "album",
    artist: "Artist",
    title,
    url: `https://artist.bandcamp.com/album/${itemId}`,
    artUrl: null,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SyncStore", () => {
  test("is idempotent and detects additions/removals without deleting records", () => {
    const database = new Database(":memory:");
    databases.push(database);
    const store = new SyncStore(database);

    const first = store.reconcileWishlist(
      42,
      [item(1), item(2)],
      "2026-01-01T00:00:00.000Z",
    );
    expect(first).toEqual({ discovered: 2, changed: 2, removed: 0, writes: 0 });

    const second = store.reconcileWishlist(
      42,
      [item(1), item(2)],
      "2026-01-02T00:00:00.000Z",
    );
    expect(second).toEqual({
      discovered: 0,
      changed: 0,
      removed: 0,
      writes: 0,
    });
    expect(store.getItem(1)?.last_scanned_at).toBe("2026-01-02T00:00:00.000Z");

    const third = store.reconcileWishlist(
      42,
      [item(2), item(3)],
      "2026-01-03T00:00:00.000Z",
    );
    expect(third).toEqual({ discovered: 1, changed: 1, removed: 1, writes: 0 });
    expect(store.listItems()).toHaveLength(3);
    expect(store.getItem(1)?.removed_at).toBe("2026-01-03T00:00:00.000Z");
  });

  test("persists interrupted write batches and resumes only pending ids", () => {
    const database = new Database(":memory:");
    databases.push(database);
    const store = new SyncStore(database);
    const runId = store.startRun("incremental");
    store.recordBatch(runId, 1, ["a", "b"], "key-a");
    store.completeBatch(runId, 1, true);
    store.recordBatch(runId, 2, ["c"], "key-c");

    expect(store.pendingBatchIds(runId)).toEqual(["c"]);
    expect(store.resumeBatchKey(runId, ["a", "b"])).toBe("key-a");
    expect(store.finishRun(runId, "interrupted")).toBe("interrupted");
    store.importWriteResults(runId, [
      { batch_number: 2, album_ids: ["c"], idempotency_key: "key-c", ok: true },
    ]);
    expect(store.pendingBatchIds(runId)).toEqual([]);
  });

  test("imports match decisions and library snapshots into the summary", () => {
    const database = new Database(":memory:");
    databases.push(database);
    const store = new SyncStore(database);
    store.importMatches([
      {
        bandcamp_item_id: 1,
        status: "high_confidence",
        best_match: { tidal_album_id: "t1" },
        candidates: [{ tidal_album_id: "t1" }],
      },
      { bandcamp_item_id: 2, status: "needs_review", candidates: [] },
      { bandcamp_item_id: 3, status: "not_found", candidates: [] },
    ]);
    store.importLibrarySnapshot([{ tidal_album_id: "t1" }]);
    expect(store.summary()).toMatchObject({
      matched: 1,
      needs_review: 1,
      not_found: 1,
      library_snapshots: 1,
    });
  });

  test("marks a sync run failed when the operation throws", () => {
    const database = new Database(":memory:");
    databases.push(database);
    const store = new SyncStore(database);
    const runId = store.startRun("incremental");
    expect(() =>
      store.runWithStatus(runId, () => {
        throw new Error("fixture failure");
      }),
    ).toThrow("fixture failure");
    expect(
      database
        .query("SELECT status FROM sync_runs WHERE run_id = ?")
        .get(runId),
    ).toEqual({ status: "failed" });
  });
  test("persists match overrides and negative decisions", () => {
    const database = new Database(":memory:");
    databases.push(database);
    const store = new SyncStore(database);
    store.setOverride(10, "tidal-1");
    store.rejectCandidate(10, "tidal-2");
    expect(store.getOverride(10)).toBe("tidal-1");
    expect(store.isRejected(10, "tidal-2")).toBe(true);
  });
});
