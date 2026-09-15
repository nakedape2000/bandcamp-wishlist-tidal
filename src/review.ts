import type { Database } from "bun:sqlite";
import { SyncStore } from "./sync-store";

export type ReviewAction = "approved" | "rejected" | "deferred" | "unavailable";

export interface ReviewFilters {
  status?: string;
  artist?: string;
  label?: string;
  minScore?: number;
  maxScore?: number;
  since?: string;
}

export interface ReviewDecision {
  bandcampItemId: number;
  action: ReviewAction;
  chosenTidalAlbumId: string | null;
  metadata: Record<string, string>;
  updatedAt: string;
}

export interface ReviewMetadataOverride {
  bandcampItemId: number;
  metadata: Record<string, string>;
  updatedAt: string;
}

export interface ReviewRecord {
  bandcampItemId: number;
  artist: string;
  title: string;
  url: string;
  artUrl: string | null;
  label: string;
  status: string;
  score: number | null;
  explanation: string;
  bestMatch: Record<string, unknown> | null;
  candidates: Array<Record<string, unknown>>;
  duplicateEditions: Array<Record<string, unknown>>;
  metadata: Record<string, string>;
  decision: ReviewDecision | null;
  scannedAt: string;
}

export interface PendingWritePlan {
  currentLibraryCount: number;
  additions: ReviewRecord[];
  additionCount: number;
  providerWrites: 0;
}

export interface PortableReviewDecisions {
  schema_version: 1;
  exported_at: string;
  decisions: ReviewDecision[];
  metadata_overrides?: ReviewMetadataOverride[];
}

interface MatchRow {
  bandcamp_item_id: number;
  status: string;
  payload: string;
  decided_at: string;
  action: ReviewAction | null;
  chosen_tidal_album_id: string | null;
  decision_metadata_json: string | null;
  edit_metadata_json: string | null;
  edit_updated_at: string | null;
  review_updated_at: string | null;
  artist: string | null;
  title: string | null;
  url: string | null;
  art_url: string | null;
}

export class ReviewService {
  constructor(private readonly database: Database) {
    new SyncStore(database);
  }

  list(filters: ReviewFilters = {}): ReviewRecord[] {
    const query = `
      SELECT m.bandcamp_item_id, m.status, m.payload, m.decided_at,
             r.action, r.chosen_tidal_album_id,
             r.metadata_json AS decision_metadata_json,
             r.updated_at AS review_updated_at,
             e.metadata_json AS edit_metadata_json,
             e.updated_at AS edit_updated_at,
             b.artist, b.title, b.url, b.art_url
      FROM match_decisions m
      LEFT JOIN bandcamp_items b ON b.source_item_id = m.bandcamp_item_id
      LEFT JOIN review_decisions r ON r.bandcamp_item_id = m.bandcamp_item_id
      LEFT JOIN review_metadata e ON e.bandcamp_item_id = m.bandcamp_item_id
      ORDER BY m.decided_at DESC, m.bandcamp_item_id
    `;
    return (this.database.query(query).all() as MatchRow[])
      .map(toReviewRecord)
      .filter((record) => matchesFilters(record, filters));
  }

  get(bandcampItemId: number): ReviewRecord | null {
    return (
      this.list().find((record) => record.bandcampItemId === bandcampItemId) ??
      null
    );
  }

  decide(
    bandcampItemId: number,
    action: ReviewAction,
    chosenTidalAlbumId?: string | null,
    updatedAt = new Date().toISOString(),
  ): ReviewDecision {
    if (!isReviewAction(action)) throw new Error("Invalid review action.");
    const record = this.get(bandcampItemId);
    if (!record) throw new Error(`Review item ${bandcampItemId} not found.`);
    const chosen =
      action === "approved"
        ? (chosenTidalAlbumId ?? String(record.bestMatch?.tidal_album_id ?? ""))
        : null;
    if (action === "approved" && !chosen)
      throw new Error("Approval requires a TIDAL candidate.");
    const candidateIds = new Set(
      record.candidates.map((candidate) =>
        String(candidate.tidal_album_id ?? ""),
      ),
    );
    if (record.bestMatch?.tidal_album_id)
      candidateIds.add(String(record.bestMatch.tidal_album_id));
    if (
      (chosen || chosenTidalAlbumId) &&
      !candidateIds.has(chosen ?? String(chosenTidalAlbumId))
    )
      throw new Error(
        `TIDAL candidate ${chosen} is not part of this review item.`,
      );
    const metadata = record.metadata;
    this.database
      .query(
        `INSERT INTO review_decisions
          (bandcamp_item_id, action, chosen_tidal_album_id, metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bandcamp_item_id) DO UPDATE SET
          action=excluded.action,
          chosen_tidal_album_id=excluded.chosen_tidal_album_id,
          metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at`,
      )
      .run(bandcampItemId, action, chosen, JSON.stringify(metadata), updatedAt);
    const rejectedCandidate =
      chosenTidalAlbumId ??
      (record.bestMatch?.tidal_album_id
        ? String(record.bestMatch.tidal_album_id)
        : null);
    if (action === "rejected" && rejectedCandidate)
      new SyncStore(this.database).rejectCandidate(
        bandcampItemId,
        rejectedCandidate,
        updatedAt,
      );
    if (action === "approved" && chosen) {
      new SyncStore(this.database).setOverride(
        bandcampItemId,
        chosen,
        updatedAt,
      );
      this.database
        .query(
          "DELETE FROM negative_decisions WHERE bandcamp_item_id = ? AND tidal_album_id = ?",
        )
        .run(bandcampItemId, chosen);
    } else {
      this.database
        .query("DELETE FROM match_overrides WHERE bandcamp_item_id = ?")
        .run(bandcampItemId);
    }
    return this.get(bandcampItemId)?.decision as ReviewDecision;
  }

  editMetadata(
    bandcampItemId: number,
    metadata: Record<string, string>,
    updatedAt = new Date().toISOString(),
  ): ReviewMetadataOverride {
    const validatedMetadata = validateMetadata(metadata);
    const record = this.get(bandcampItemId);
    if (!record) throw new Error(`Review item ${bandcampItemId} not found.`);
    const merged = { ...record.metadata, ...validatedMetadata };
    this.database
      .query(
        `INSERT INTO review_metadata
          (bandcamp_item_id, metadata_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(bandcamp_item_id) DO UPDATE SET
          metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
      )
      .run(bandcampItemId, JSON.stringify(merged), updatedAt);
    return { bandcampItemId, metadata: merged, updatedAt };
  }

  pendingWrite(): ReviewRecord[] {
    return this.pendingPlan().additions;
  }

  pendingPlan(): PendingWritePlan {
    const latest = this.database
      .query(
        "SELECT payload FROM tidal_library_snapshots ORDER BY snapshot_id DESC LIMIT 1",
      )
      .get() as { payload: string } | null;
    const saved = new Set(
      latest
        ? (JSON.parse(latest.payload) as Array<Record<string, unknown>>)
            .map((album) => String(album.tidal_album_id ?? ""))
            .filter(Boolean)
        : [],
    );
    const additionIds = new Set<string>();
    const additions = this.list().filter((record) => {
      const id = record.decision?.chosenTidalAlbumId;
      if (
        record.decision?.action !== "approved" ||
        !id ||
        saved.has(id) ||
        additionIds.has(id)
      )
        return false;
      additionIds.add(id);
      return true;
    });
    return {
      currentLibraryCount: saved.size,
      additions,
      additionCount: additions.length,
      providerWrites: 0,
    };
  }

  exportDecisions(
    exportedAt = new Date().toISOString(),
  ): PortableReviewDecisions {
    const decisions = this.database
      .query(
        "SELECT bandcamp_item_id, action, chosen_tidal_album_id, metadata_json, updated_at FROM review_decisions ORDER BY bandcamp_item_id",
      )
      .all() as Array<{
      bandcamp_item_id: number;
      action: ReviewAction;
      chosen_tidal_album_id: string | null;
      metadata_json: string;
      updated_at: string;
    }>;
    const metadataOverrides = this.database
      .query(
        "SELECT bandcamp_item_id, metadata_json, updated_at FROM review_metadata ORDER BY bandcamp_item_id",
      )
      .all() as Array<{
      bandcamp_item_id: number;
      metadata_json: string;
      updated_at: string;
    }>;
    return {
      schema_version: 1,
      exported_at: exportedAt,
      decisions: decisions.map((row) => ({
        bandcampItemId: row.bandcamp_item_id,
        action: row.action,
        chosenTidalAlbumId: row.chosen_tidal_album_id,
        metadata: JSON.parse(row.metadata_json) as Record<string, string>,
        updatedAt: row.updated_at,
      })),
      metadata_overrides: metadataOverrides.map((row) => ({
        bandcampItemId: row.bandcamp_item_id,
        metadata: JSON.parse(row.metadata_json) as Record<string, string>,
        updatedAt: row.updated_at,
      })),
    };
  }

  importDecisions(document: PortableReviewDecisions): number {
    if (document.schema_version !== 1 || !Array.isArray(document.decisions))
      throw new Error("Invalid review decision document.");
    for (const decision of document.decisions) {
      if (
        !Number.isInteger(decision.bandcampItemId) ||
        decision.bandcampItemId <= 0 ||
        !isReviewAction(decision.action) ||
        typeof decision.metadata !== "object" ||
        decision.metadata === null ||
        typeof decision.updatedAt !== "string"
      )
        throw new Error("Invalid review decision document.");
      validateMetadata(decision.metadata);
    }
    const metadataOverrides = document.metadata_overrides ?? [];
    if (!Array.isArray(metadataOverrides))
      throw new Error("Invalid review decision document.");
    for (const override of metadataOverrides) {
      if (
        !Number.isInteger(override.bandcampItemId) ||
        override.bandcampItemId <= 0 ||
        typeof override.updatedAt !== "string" ||
        typeof override.metadata !== "object" ||
        override.metadata === null
      )
        throw new Error("Invalid review decision document.");
      validateMetadata(override.metadata);
    }
    const transaction = (this.database as Database).transaction(() => {
      for (const decision of document.decisions) {
        this.decide(
          decision.bandcampItemId,
          decision.action,
          decision.chosenTidalAlbumId,
          decision.updatedAt,
        );
        if (Object.keys(decision.metadata).length)
          this.editMetadata(
            decision.bandcampItemId,
            decision.metadata,
            decision.updatedAt,
          );
      }
      for (const override of metadataOverrides)
        this.editMetadata(
          override.bandcampItemId,
          override.metadata,
          override.updatedAt,
        );
    });
    transaction();
    return new Set([
      ...document.decisions.map((decision) => decision.bandcampItemId),
      ...metadataOverrides.map((override) => override.bandcampItemId),
    ]).size;
  }
}

function toReviewRecord(row: MatchRow): ReviewRecord {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const bestMatch = (payload.best_match ?? null) as Record<
    string,
    unknown
  > | null;
  const metadata = {
    ...(JSON.parse(row.decision_metadata_json ?? "{}") as Record<
      string,
      string
    >),
    ...(JSON.parse(row.edit_metadata_json ?? "{}") as Record<string, string>),
  };
  return {
    bandcampItemId: row.bandcamp_item_id,
    artist:
      metadata.artist ?? row.artist ?? String(payload.bandcamp_artist ?? ""),
    title: metadata.title ?? row.title ?? String(payload.bandcamp_title ?? ""),
    url: row.url ?? String(payload.bandcamp_url ?? ""),
    artUrl: row.art_url,
    label: metadata.label ?? String(payload.bandcamp_label_hint ?? ""),
    status: row.status,
    score: bestMatch?.score == null ? null : Number(bestMatch.score),
    explanation: String(
      payload.explanation ??
        bestMatch?.explanation ??
        "No explanation recorded.",
    ),
    bestMatch,
    candidates: Array.isArray(payload.candidates)
      ? (payload.candidates as Array<Record<string, unknown>>)
      : [],
    duplicateEditions: Array.isArray(payload.duplicate_editions)
      ? (payload.duplicate_editions as Array<Record<string, unknown>>)
      : [],
    metadata,
    decision: row.action
      ? {
          bandcampItemId: row.bandcamp_item_id,
          action: row.action,
          chosenTidalAlbumId: row.chosen_tidal_album_id,
          metadata,
          updatedAt: row.review_updated_at as string,
        }
      : null,
    scannedAt: row.decided_at,
  };
}

function isReviewAction(value: unknown): value is ReviewAction {
  return (
    value === "approved" ||
    value === "rejected" ||
    value === "deferred" ||
    value === "unavailable"
  );
}

function validateMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(["artist", "title", "label"]);
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key) || typeof value !== "string" || value.length > 500)
      throw new Error(
        "Metadata may only contain artist, title, and label strings.",
      );
    validated[key] = value.trim();
  }
  return validated;
}

function matchesFilters(record: ReviewRecord, filters: ReviewFilters): boolean {
  const effectiveStatus = record.decision?.action ?? record.status;
  if (filters.status && effectiveStatus !== filters.status) return false;
  if (
    filters.artist &&
    !record.artist.toLowerCase().includes(filters.artist.toLowerCase())
  )
    return false;
  if (
    filters.label &&
    !record.label.toLowerCase().includes(filters.label.toLowerCase())
  )
    return false;
  if (
    filters.minScore != null &&
    (record.score ?? -Infinity) < filters.minScore
  )
    return false;
  if (filters.maxScore != null && (record.score ?? Infinity) > filters.maxScore)
    return false;
  if (filters.since && record.scannedAt < filters.since) return false;
  return true;
}
