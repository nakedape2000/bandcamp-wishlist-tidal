import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WishlistItem } from "./types";

export interface ReconcileSummary {
  discovered: number;
  changed: number;
  removed: number;
  writes: number;
}

export class SyncStore {
  constructor(private readonly database: Database) {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS bandcamp_items (
        internal_id TEXT PRIMARY KEY,
        fan_id INTEGER NOT NULL,
        source_item_id INTEGER NOT NULL,
        item_type TEXT NOT NULL,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        art_url TEXT,
        added_at TEXT,
        source_fingerprint TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_scanned_at TEXT,
        last_synced_at TEXT,
        removed_at TEXT,
        UNIQUE(fan_id, source_item_id)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS write_batches (
        run_id INTEGER NOT NULL REFERENCES sync_runs(run_id),
        batch_number INTEGER NOT NULL,
        item_ids TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY(run_id, batch_number)
      );
      CREATE TABLE IF NOT EXISTS tidal_candidates (
        bandcamp_item_id INTEGER NOT NULL,
        tidal_album_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        PRIMARY KEY (bandcamp_item_id, tidal_album_id)
      );
      CREATE TABLE IF NOT EXISTS match_decisions (
        bandcamp_item_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        best_match_id TEXT,
        payload TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tidal_library_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_overrides (
        bandcamp_item_id INTEGER PRIMARY KEY,
        tidal_album_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS negative_decisions (
        bandcamp_item_id INTEGER NOT NULL,
        tidal_album_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bandcamp_item_id, tidal_album_id)
      );
      CREATE TABLE IF NOT EXISTS review_decisions (
        bandcamp_item_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        chosen_tidal_album_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_metadata (
        bandcamp_item_id INTEGER PRIMARY KEY,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS write_plans (
        plan_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        collection TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        max_additions INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS write_plan_items (
        plan_id TEXT NOT NULL REFERENCES write_plans(plan_id),
        position INTEGER NOT NULL,
        bandcamp_item_id INTEGER NOT NULL,
        tidal_album_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        PRIMARY KEY(plan_id, position),
        UNIQUE(plan_id, tidal_album_id)
      );
      CREATE TABLE IF NOT EXISTS write_attempts (
        plan_id TEXT NOT NULL REFERENCES write_plans(plan_id),
        batch_number INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        response_status INTEGER,
        response_body_hash TEXT,
        response_body TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(plan_id, batch_number)
      );
    `);
  }

  reconcileWishlist(
    fanId: number,
    items: WishlistItem[],
    seenAt: string,
  ): ReconcileSummary {
    const seen = new Set<number>();
    let discovered = 0;
    let changed = 0;
    const upsert = this.database.prepare(`
      INSERT INTO bandcamp_items (
        internal_id, fan_id, source_item_id, item_type, artist, title, url,
        art_url, added_at, source_fingerprint, first_seen_at, last_seen_at,
        last_scanned_at, removed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(fan_id, source_item_id) DO UPDATE SET
        item_type=excluded.item_type, artist=excluded.artist, title=excluded.title,
        url=excluded.url, art_url=excluded.art_url, added_at=excluded.added_at,
        source_fingerprint=excluded.source_fingerprint, last_seen_at=excluded.last_seen_at,
        last_scanned_at=excluded.last_scanned_at, removed_at=NULL
    `);
    const find = this.database.prepare(
      "SELECT source_fingerprint, removed_at FROM bandcamp_items WHERE fan_id = ? AND source_item_id = ?",
    );
    const transaction = this.database.transaction(() => {
      for (const item of items) {
        seen.add(item.itemId);
        const fingerprint = fingerprintFor(item);
        const previous = find.get(fanId, item.itemId) as {
          source_fingerprint: string;
          removed_at: string | null;
        } | null;
        if (!previous) discovered++;
        if (
          !previous ||
          previous.source_fingerprint !== fingerprint ||
          previous.removed_at
        )
          changed++;
        upsert.run(
          internalId(fanId, item.itemId),
          fanId,
          item.itemId,
          item.itemType,
          item.artist,
          item.title,
          item.url,
          item.artUrl,
          item.addedAt,
          fingerprint,
          seenAt,
          seenAt,
          seenAt,
        );
      }
      const existing = this.database
        .query(
          "SELECT source_item_id FROM bandcamp_items WHERE fan_id = ? AND removed_at IS NULL",
        )
        .all(fanId) as Array<{ source_item_id: number }>;
      let removed = 0;
      const markRemoved = this.database.prepare(
        "UPDATE bandcamp_items SET removed_at = ?, last_seen_at = ? WHERE fan_id = ? AND source_item_id = ? AND removed_at IS NULL",
      );
      for (const row of existing)
        if (!seen.has(row.source_item_id)) {
          markRemoved.run(seenAt, seenAt, fanId, row.source_item_id);
          removed++;
        }
      return removed;
    });
    const removed = transaction();
    return { discovered, changed, removed, writes: 0 };
  }

  listItems(): Array<Record<string, unknown>> {
    return this.database
      .query("SELECT * FROM bandcamp_items ORDER BY source_item_id")
      .all() as Array<Record<string, unknown>>;
  }
  getItem(sourceItemId: number): Record<string, string | number | null> | null {
    return this.database
      .query("SELECT * FROM bandcamp_items WHERE source_item_id = ?")
      .get(sourceItemId) as Record<string, string | number | null> | null;
  }
  startRun(mode: string, startedAt = new Date().toISOString()): number {
    const row = this.database
      .query(
        "INSERT INTO sync_runs (mode, started_at, status) VALUES (?, ?, 'running') RETURNING run_id",
      )
      .get(mode, startedAt) as { run_id: number };
    return Number(row.run_id);
  }
  finishRun(
    runId: number,
    status: string,
    finishedAt = new Date().toISOString(),
  ): string {
    this.database
      .query(
        "UPDATE sync_runs SET status = ?, finished_at = ? WHERE run_id = ?",
      )
      .run(status, finishedAt, runId);
    return status;
  }
  runWithStatus<T>(runId: number, operation: () => T): T {
    try {
      const value = operation();
      this.finishRun(runId, "completed");
      return value;
    } catch (error) {
      this.finishRun(runId, "failed");
      throw error;
    }
  }
  recordBatch(
    runId: number,
    batchNumber: number,
    itemIds: string[],
    idempotencyKey: string,
  ): void {
    this.database
      .query(
        "INSERT OR REPLACE INTO write_batches (run_id, batch_number, item_ids, idempotency_key) VALUES (?, ?, ?, ?)",
      )
      .run(runId, batchNumber, JSON.stringify(itemIds), idempotencyKey);
  }
  completeBatch(runId: number, batchNumber: number, ok: boolean): void {
    this.database
      .query(
        "UPDATE write_batches SET status = ? WHERE run_id = ? AND batch_number = ?",
      )
      .run(ok ? "complete" : "failed", runId, batchNumber);
  }
  importWriteResults(
    runId: number,
    batches: Array<Record<string, unknown>>,
  ): void {
    for (const batch of batches) {
      const ids = Array.isArray(batch.album_ids)
        ? batch.album_ids.map(String)
        : [];
      const key = String(
        batch.idempotency_key ?? `legacy-${batch.batch_number}`,
      );
      this.recordBatch(runId, Number(batch.batch_number), ids, key);
      this.completeBatch(runId, Number(batch.batch_number), batch.ok === true);
    }
  }
  pendingBatchIds(runId: number): string[] {
    const rows = this.database
      .query(
        "SELECT item_ids FROM write_batches WHERE run_id = ? AND status <> 'complete' ORDER BY batch_number",
      )
      .all(runId) as Array<{ item_ids: string }>;
    return rows.flatMap((row) => JSON.parse(row.item_ids) as string[]);
  }
  resumeBatchKey(runId: number, itemIds: string[]): string | null {
    const rows = this.database
      .query(
        "SELECT item_ids, idempotency_key FROM write_batches WHERE run_id = ?",
      )
      .all(runId) as Array<{ item_ids: string; idempotency_key: string }>;
    const target = JSON.stringify(itemIds);
    return rows.find((row) => row.item_ids === target)?.idempotency_key ?? null;
  }
  importMatches(
    matches: Array<Record<string, unknown>>,
    scannedAt = new Date().toISOString(),
  ): void {
    const candidate = this.database.prepare(
      "INSERT OR REPLACE INTO tidal_candidates (bandcamp_item_id, tidal_album_id, payload, source_fingerprint, scanned_at) VALUES (?, ?, ?, ?, ?)",
    );
    const decision = this.database.prepare(
      "INSERT OR REPLACE INTO match_decisions (bandcamp_item_id, status, best_match_id, payload, decided_at) VALUES (?, ?, ?, ?, ?)",
    );
    const transaction = this.database.transaction(() => {
      for (const match of matches) {
        const itemId = Number(match.bandcamp_item_id);
        const best = (match.best_match ?? {}) as Record<string, unknown>;
        const candidates = Array.isArray(match.candidates)
          ? match.candidates
          : [];
        for (const value of candidates) {
          const candidateValue = value as Record<string, unknown>;
          const tidalId = String(candidateValue.tidal_album_id ?? "");
          if (tidalId)
            candidate.run(
              itemId,
              tidalId,
              JSON.stringify(candidateValue),
              fingerprintForValue(candidateValue),
              scannedAt,
            );
        }
        decision.run(
          itemId,
          String(match.status ?? "needs_review"),
          best.tidal_album_id ? String(best.tidal_album_id) : null,
          JSON.stringify(match),
          scannedAt,
        );
      }
    });
    transaction();
  }
  importLibrarySnapshot(
    library: Array<Record<string, unknown>>,
    capturedAt = new Date().toISOString(),
  ): number {
    this.database
      .query(
        "INSERT INTO tidal_library_snapshots (captured_at, payload) VALUES (?, ?)",
      )
      .run(capturedAt, JSON.stringify(library));
    return library.length;
  }
  setOverride(
    bandcampItemId: number,
    tidalAlbumId: string,
    updatedAt = new Date().toISOString(),
  ): void {
    this.database
      .query(
        "INSERT OR REPLACE INTO match_overrides (bandcamp_item_id, tidal_album_id, updated_at) VALUES (?, ?, ?)",
      )
      .run(bandcampItemId, tidalAlbumId, updatedAt);
  }
  getOverride(bandcampItemId: number): string | null {
    const row = this.database
      .query(
        "SELECT tidal_album_id FROM match_overrides WHERE bandcamp_item_id = ?",
      )
      .get(bandcampItemId) as { tidal_album_id: string } | null;
    return row?.tidal_album_id ?? null;
  }
  rejectCandidate(
    bandcampItemId: number,
    tidalAlbumId: string,
    updatedAt = new Date().toISOString(),
  ): void {
    this.database
      .query(
        "INSERT OR REPLACE INTO negative_decisions (bandcamp_item_id, tidal_album_id, updated_at) VALUES (?, ?, ?)",
      )
      .run(bandcampItemId, tidalAlbumId, updatedAt);
  }
  isRejected(bandcampItemId: number, tidalAlbumId: string): boolean {
    return Boolean(
      this.database
        .query(
          "SELECT 1 FROM negative_decisions WHERE bandcamp_item_id = ? AND tidal_album_id = ?",
        )
        .get(bandcampItemId, tidalAlbumId),
    );
  }

  createWritePlan(plan: {
    planId: string;
    createdAt: string;
    provider: string;
    collection: string;
    maxAdditions: number;
    items: Array<{
      bandcampItemId: number;
      tidalAlbumId: string;
      source: unknown;
    }>;
    payload: unknown;
  }): void {
    this.database
      .query(
        `INSERT INTO write_plans
          (plan_id, created_at, provider, collection, status, max_additions, payload_json)
         VALUES (?, ?, ?, ?, 'proposed', ?, ?)`,
      )
      .run(
        plan.planId,
        plan.createdAt,
        plan.provider,
        plan.collection,
        plan.maxAdditions,
        JSON.stringify(plan.payload),
      );
    const item = this.database.prepare(
      `INSERT INTO write_plan_items
        (plan_id, position, bandcamp_item_id, tidal_album_id, source_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [position, value] of plan.items.entries())
      item.run(
        plan.planId,
        position,
        value.bandcampItemId,
        value.tidalAlbumId,
        JSON.stringify(value.source),
      );
  }

  getWritePlan(planId: string): Record<string, unknown> | null {
    const plan = this.database
      .query("SELECT * FROM write_plans WHERE plan_id = ?")
      .get(planId) as Record<string, unknown> | null;
    if (!plan) return null;
    return {
      ...plan,
      payload: JSON.parse(String(plan.payload_json)),
      items: this.database
        .query(
          "SELECT position, bandcamp_item_id, tidal_album_id, source_json FROM write_plan_items WHERE plan_id = ? ORDER BY position",
        )
        .all(planId)
        .map((item: unknown) => {
          const row = item as Record<string, unknown>;
          return {
            position: row.position,
            bandcampItemId: row.bandcamp_item_id,
            tidalAlbumId: row.tidal_album_id,
            source: JSON.parse(String(row.source_json)),
          };
        }),
    };
  }

  setWritePlanStatus(planId: string, status: string): void {
    this.database
      .query("UPDATE write_plans SET status = ? WHERE plan_id = ?")
      .run(status, planId);
  }

  recordWriteAttempt(attempt: {
    planId: string;
    batchNumber: number;
    idempotencyKey: string;
    payload: unknown;
    startedAt: string;
    status?: string;
    responseStatus?: number | null;
    responseBodyHash?: string | null;
    responseBody?: string | null;
    retries?: number;
  }): void {
    this.database
      .query(
        `INSERT INTO write_attempts
          (plan_id, batch_number, idempotency_key, payload_json, started_at, finished_at, status, response_status, response_body_hash, response_body, retries)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id, batch_number) DO UPDATE SET
          idempotency_key=excluded.idempotency_key, payload_json=excluded.payload_json,
          finished_at=excluded.finished_at, status=excluded.status,
          response_status=excluded.response_status, response_body_hash=excluded.response_body_hash,
          response_body=excluded.response_body, retries=excluded.retries`,
      )
      .run(
        attempt.planId,
        attempt.batchNumber,
        attempt.idempotencyKey,
        JSON.stringify(attempt.payload),
        attempt.startedAt,
        attempt.status ? new Date().toISOString() : null,
        attempt.status ?? "pending",
        attempt.responseStatus ?? null,
        attempt.responseBodyHash ?? null,
        attempt.responseBody ?? null,
        attempt.retries ?? 0,
      );
  }

  listWriteAttempts(planId: string): Array<Record<string, unknown>> {
    return this.database
      .query(
        "SELECT * FROM write_attempts WHERE plan_id = ? ORDER BY batch_number",
      )
      .all(planId) as Array<Record<string, unknown>>;
  }
  summary(): Record<string, number> {
    const count = (sql: string) =>
      Number((this.database.query(sql).get() as { count: number }).count);
    const latest = this.database
      .query(
        "SELECT payload FROM tidal_library_snapshots ORDER BY snapshot_id DESC LIMIT 1",
      )
      .get() as { payload: string } | null;
    const libraryIds = new Set(
      latest
        ? (JSON.parse(latest.payload) as Array<Record<string, unknown>>).map(
            (item) => String(item.tidal_album_id ?? ""),
          )
        : [],
    );
    const decisions = this.database
      .query("SELECT status, best_match_id FROM match_decisions")
      .all() as Array<{ status: string; best_match_id: string | null }>;
    const alreadySaved = decisions.filter(
      (item) =>
        item.status === "high_confidence" &&
        item.best_match_id &&
        libraryIds.has(item.best_match_id),
    ).length;
    const approvedPending = decisions.filter(
      (item) =>
        item.status === "high_confidence" &&
        item.best_match_id &&
        !libraryIds.has(item.best_match_id),
    ).length;
    return {
      wishlist_items: count(
        "SELECT count(*) AS count FROM bandcamp_items WHERE removed_at IS NULL",
      ),
      removed_items: count(
        "SELECT count(*) AS count FROM bandcamp_items WHERE removed_at IS NOT NULL",
      ),
      matched: count(
        "SELECT count(*) AS count FROM match_decisions WHERE status IN ('high_confidence', 'medium_confidence')",
      ),
      needs_review: count(
        "SELECT count(*) AS count FROM match_decisions WHERE status NOT IN ('high_confidence', 'medium_confidence', 'not_found')",
      ),
      not_found: count(
        "SELECT count(*) AS count FROM match_decisions WHERE status = 'not_found'",
      ),
      already_saved: alreadySaved,
      approved_pending_write: approvedPending,
      written: 0,
      failed: 0,
      library_snapshots: count(
        "SELECT count(*) AS count FROM tidal_library_snapshots",
      ),
    };
  }
}

function internalId(fanId: number, itemId: number): string {
  return `bc:${fanId}:${itemId}`;
}
function fingerprintFor(item: WishlistItem): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}
function fingerprintForValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
