import { createHash } from "node:crypto";
import { createBatches, idempotencyKeyForBatch } from "./batches";
import { type AppConfig, defaultConfig } from "./config";
import type { ReviewService } from "./review";
import type { SyncStore } from "./sync-store";

export interface WritePlanItem {
  bandcampItemId: number;
  tidalAlbumId: string;
  artist: string;
  title: string;
  tidalTitle: string;
  tidalArtists: string[];
  score: number | null;
  bandcampUrl: string;
  tidalUrl: string;
}

export interface WritePlan {
  planId: string;
  createdAt: string;
  provider: "tidal";
  collection: "me";
  status: "proposed";
  maxAdditions: number;
  items: WritePlanItem[];
  libraryCount: number;
  additionCount: number;
  providerWrites: 0;
}

export function buildWritePlan(
  reviews: ReviewService,
  config: AppConfig = defaultConfig(),
  createdAt = new Date().toISOString(),
): WritePlan {
  const pending = reviews.pendingPlan();
  if (pending.additionCount > config.sync.max_additions_per_run)
    throw new Error(
      `Safety stop: ${pending.additionCount} additions exceed configured maximum ${config.sync.max_additions_per_run}.`,
    );
  const items = pending.additions.map((record) => {
    const match = record.decision?.chosenTidalAlbumId
      ? (record.candidates.find(
          (candidate) =>
            String(candidate.tidal_album_id) ===
            record.decision?.chosenTidalAlbumId,
        ) ?? record.bestMatch)
      : record.bestMatch;
    return {
      bandcampItemId: record.bandcampItemId,
      tidalAlbumId: String(record.decision?.chosenTidalAlbumId),
      artist: record.artist,
      title: record.title,
      tidalTitle: String(match?.tidal_title ?? ""),
      tidalArtists: Array.isArray(match?.tidal_artists)
        ? match.tidal_artists.map(String)
        : [],
      score: record.score,
      bandcampUrl: record.url,
      tidalUrl: String(
        match?.tidal_url ??
          `https://tidal.com/browse/album/${record.decision?.chosenTidalAlbumId}`,
      ),
    } satisfies WritePlanItem;
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ items, max: config.sync.max_additions_per_run }))
    .digest("hex")
    .slice(0, 16);
  return {
    planId: `tidal-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${fingerprint}`,
    createdAt,
    provider: "tidal",
    collection: "me",
    status: "proposed",
    maxAdditions: config.sync.max_additions_per_run,
    items,
    libraryCount: pending.currentLibraryCount,
    additionCount: items.length,
    providerWrites: 0,
  };
}

export function persistWritePlan(store: SyncStore, plan: WritePlan): void {
  if (store.getWritePlan(plan.planId))
    throw new Error(
      `Write plan ${plan.planId} already exists and is immutable.`,
    );
  store.createWritePlan({
    planId: plan.planId,
    createdAt: plan.createdAt,
    provider: plan.provider,
    collection: plan.collection,
    maxAdditions: plan.maxAdditions,
    items: plan.items.map((item) => ({
      bandcampItemId: item.bandcampItemId,
      tidalAlbumId: item.tidalAlbumId,
      source: item,
    })),
    payload: plan,
  });
}

export function planBatches(
  plan: WritePlan,
  size: number,
): Array<{
  albumIds: string[];
  payload: { data: Array<{ id: string; type: "albums" }> };
  idempotencyKey: string;
}> {
  return createBatches(plan.items, size).map((batch, index) => {
    const albumIds = batch.map((item) => item.tidalAlbumId);
    return {
      albumIds,
      payload: {
        data: albumIds.map((id) => ({ id, type: "albums" as const })),
      },
      idempotencyKey: idempotencyKeyForBatch(
        `${plan.planId}:${index + 1}`,
        albumIds,
      ),
    };
  });
}

export function numberedPlanBatches(
  plan: WritePlan,
  size: number,
): Array<
  ReturnType<typeof planBatches>[number] & {
    batchNumber: number;
  }
> {
  return planBatches(plan, size).map((batch, index) => ({
    ...batch,
    batchNumber: index + 1,
  }));
}

export function hashResponseBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
