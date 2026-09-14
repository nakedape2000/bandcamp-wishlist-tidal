import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { idempotencyKeyForBatch } from "../src/batches";
import { loadConfig } from "../src/config";
import { ReviewService } from "../src/review";
import { SyncStore } from "../src/sync-store";
import { fetchTidalLibraryIds, TidalClient } from "../src/tidal";
import {
  buildWritePlan,
  hashResponseBody,
  persistWritePlan,
  planBatches,
  type WritePlan,
} from "../src/write-orchestrator";

const args = process.argv.slice(2);
const command = args.shift();
const config = loadConfig(option("--config"));
const databasePath =
  option("--database") ?? process.env.BCTS_DATABASE ?? config.storage.database;
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
const store = new SyncStore(database);
const reviews = new ReviewService(database);

try {
  if (command === "plan") {
    const subcommand =
      args[0] && !args[0].startsWith("--") ? args.shift() : "create";
    if (subcommand === "create") createPlan();
    else if (subcommand === "show") showPlan(requiredPlanId("plan show"));
    else throw new Error(`Unknown plan command: ${subcommand}`);
  } else if (command === "apply") await applyPlan(requiredPlanId());
  else throw new Error("Use `sync plan` or `sync apply <plan-id>`. ");
} finally {
  database.close();
}

function showPlan(planId: string): void {
  const plan = store.getWritePlan(planId);
  if (!plan) throw new Error(`Write plan ${planId} not found.`);
  console.log(JSON.stringify(plan, null, 2));
}

function createPlan(): void {
  const plan = buildWritePlan(reviews, config);
  persistWritePlan(store, plan);
  const path = option("--out");
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(plan, null, 2), "utf8");
    chmodSync(path, 0o600);
  }
  const summary = {
    plan_id: plan.planId,
    provider: plan.provider,
    collection: plan.collection,
    addition_count: plan.additionCount,
    library_count: plan.libraryCount,
    provider_writes: 0,
    output: path ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!args.includes("--json"))
    console.log(
      "Plan is immutable. Inspect it, then use `sync apply <plan-id> --apply`.",
    );
}

async function applyPlan(planId: string): Promise<void> {
  const row = store.getWritePlan(planId);
  if (!row) throw new Error(`Write plan ${planId} not found.`);
  if (row.status === "completed") {
    console.log("Plan is already completed. Provider writes: 0.");
    return;
  }
  const plan = row.payload as WritePlan;
  if (!args.includes("--apply")) {
    if (args.includes("--json"))
      console.log(
        JSON.stringify({
          plan_id: planId,
          mode: "dry-run",
          provider: plan.provider,
          collection: plan.collection,
          additions: plan.additionCount,
          provider_writes: 0,
        }),
      );
    else {
      console.log(`Dry run only. Plan ${planId} is unchanged.`);
      console.log(
        `Provider: ${plan.provider}; collection: ${plan.collection}; additions: ${plan.additionCount}; provider writes: 0.`,
      );
    }
    return;
  }
  console.log("Targets in this immutable plan:");
  for (const [index, item] of plan.items.slice(0, 10).entries())
    console.log(
      `  ${index + 1}. ${item.artist} - ${item.title} -> ${item.tidalTitle || item.tidalAlbumId} (${item.tidalAlbumId})`,
    );
  if (plan.items.length > 10)
    console.log(`  ... and ${plan.items.length - 10} more.`);
  await confirm(
    `Apply plan ${planId}: add ${plan.additionCount} album(s) to TIDAL collection ${plan.collection}?`,
  );
  const client = new TidalClient();
  const liveIds = await fetchTidalLibraryIds(client);
  const pending = plan.items.filter((item) => !liveIds.has(item.tidalAlbumId));
  console.log(
    `Live TIDAL library: ${liveIds.size}; skipped already saved: ${plan.items.length - pending.length}; pending: ${pending.length}.`,
  );
  if (!pending.length) {
    store.setWritePlanStatus(planId, "completed");
    console.log("Nothing to add after live recheck. Provider writes: 0.");
    return;
  }
  const pendingPlan = {
    ...plan,
    items: pending,
    additionCount: pending.length,
  };
  const batches = planBatches(pendingPlan, config.sync.batch_size);
  const priorAttempts = new Map(
    store
      .listWriteAttempts(planId)
      .map((attempt) => [Number(attempt.batch_number), attempt]),
  );
  store.setWritePlanStatus(planId, "applying");
  for (const [index, batch] of batches.entries()) {
    const batchNumber = index + 1;
    const prior = priorAttempts.get(batchNumber);
    if (prior?.status === "success" || prior?.status === "skipped") {
      console.log(
        `Batch ${batchNumber}/${batches.length}: already recorded as ${prior.status}; skipped.`,
      );
      continue;
    }
    const batchLiveIds = await fetchTidalLibraryIds(client);
    const batchPendingIds = batch.albumIds.filter(
      (id) => !batchLiveIds.has(id),
    );
    if (!batchPendingIds.length) {
      store.recordWriteAttempt({
        planId,
        batchNumber,
        idempotencyKey: batch.idempotencyKey,
        payload: batch.payload,
        startedAt: new Date().toISOString(),
        status: "skipped",
        responseStatus: 200,
        responseBodyHash: hashResponseBody("already present in live library"),
        responseBody: "already present in live library",
      });
      console.log(
        `Batch ${batchNumber}/${batches.length}: already saved after live recheck; skipped.`,
      );
      continue;
    }
    const batchPayload = {
      data: batchPendingIds.map((id) => ({ id, type: "albums" as const })),
    };
    const batchKey = idempotencyKeyForBatch(
      `${planId}:${batchNumber}`,
      batchPendingIds,
    );
    const startedAt = new Date().toISOString();
    store.recordWriteAttempt({
      planId,
      batchNumber,
      idempotencyKey: batchKey,
      payload: batchPayload,
      startedAt,
    });
    try {
      const result = await client.post(
        "/userCollectionAlbums/me/relationships/items",
        batchPayload,
        batchKey,
      );
      const body = JSON.stringify(result.body ?? null);
      store.recordWriteAttempt({
        planId,
        batchNumber,
        idempotencyKey: batchKey,
        payload: batchPayload,
        startedAt,
        status: "success",
        responseStatus: result.status,
        responseBodyHash: hashResponseBody(body),
        responseBody: body,
      });
      console.log(
        `Batch ${batchNumber}/${batches.length}: HTTP ${result.status}; ${batchPendingIds.length} album(s).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.recordWriteAttempt({
        planId,
        batchNumber,
        idempotencyKey: batchKey,
        payload: batchPayload,
        startedAt,
        status: "unknown",
        responseBodyHash: hashResponseBody(message),
        responseBody: message,
      });
      store.setWritePlanStatus(planId, "failed");
      throw new Error(
        `Stopped after ambiguous/failed batch ${batchNumber}: ${message}`,
      );
    }
  }
  const verifiedIds = await fetchTidalLibraryIds(client);
  const missing = pending.filter((item) => !verifiedIds.has(item.tidalAlbumId));
  if (missing.length) {
    store.setWritePlanStatus(planId, "verification_failed");
    throw new Error(
      `Verification failed: ${missing.length} album(s) are missing from the live library.`,
    );
  }
  store.setWritePlanStatus(planId, "completed");
  console.log(
    `Verified ${pending.length} album(s) in TIDAL. Provider writes: ${pending.length}.`,
  );
}

async function confirm(question: string): Promise<void> {
  if (args.includes("--yes")) return;
  if (!process.stdin.isTTY)
    throw new Error("Confirmation requires an interactive terminal or --yes.");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    if (answer.trim().toLowerCase() !== "y") throw new Error("Cancelled.");
  } finally {
    prompt.close();
  }
}

function requiredPlanId(commandName = "apply"): string {
  const value = args.shift();
  if (!value || value.startsWith("--"))
    throw new Error(`${commandName} requires a plan id.`);
  return value;
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
