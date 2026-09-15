import { createHash } from "node:crypto";

export interface BatchRecord {
  ok?: boolean;
  album_ids?: string[];
}

export function createBatches<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0)
    throw new Error("Batch size must be a positive integer");
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}

export function successfulIds(records: readonly BatchRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.ok !== true) continue;
    for (const id of record.album_ids ?? []) ids.add(String(id));
  }
  return ids;
}

export function idempotencyKeyForBatch(
  manifestId: string,
  albumIds: readonly string[],
): string {
  const digest = createHash("sha256")
    .update(`${manifestId}\n${albumIds.join("\n")}`)
    .digest("hex");
  return `bandcamp-tidal-${digest.slice(0, 32)}`;
}
