import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { configPath, loadConfig } from "../src/config";
import { M7OperationRunner } from "../src/m7-runner";
import { M7Service } from "../src/m7-service";
import type { ReviewRecord } from "../src/review";

if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error(
    "Guided mode requires an interactive terminal. For automation use `bandcamp-tidal-sync scan --json`, `bandcamp-tidal-sync status --json`, or another direct command.",
  );

const args = process.argv.slice(2);
const requestedConfig = option("--config");
const config = loadConfig(requestedConfig ?? configPath());
const databasePath =
  option("--database") ?? process.env.BCTS_DATABASE ?? config.storage.database;
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
const service = new M7Service(database, databasePath, config);
const runner = new M7OperationRunner();
const prompt = createInterface({
  input: process.stdin,
  output: process.stdout,
});

let quitting = false;
process.once("SIGINT", () => {
  runner.cancel();
  quitting = true;
  prompt.close();
  console.log("\nStopped safely. No new provider write was started.");
});

try {
  await guidedHome(prompt);
} finally {
  prompt.close();
  database.close();
}

async function guidedHome(input: Interface): Promise<void> {
  while (!quitting) {
    renderHome();
    const choice = (await input.question("Choose an action: ")).trim();
    if (choice === "q" || choice === "quit") break;
    if (choice === "1") await refresh();
    else if (choice === "2") await review(input);
    else if (choice === "3") await previewPlan(input);
    else if (choice === "4") await applyPlan(input);
    else if (choice === "5") diagnostics();
    else if (choice === "6") setupHelp();
    else if (choice === "?") help();
    else console.log("Enter 1-6, ? for help, or q to quit.");
    if (!quitting) await input.question("\nPress Enter to return home. ");
  }
  console.log("\nFinished. TIDAL was not changed by refresh, review, or plan.");
}

function renderHome(): void {
  const summary = service.summary();
  const run = summary.lastRun;
  console.clear();
  console.log("BANDCAMP -> TIDAL\n");
  console.log(`Database: ${summary.database}`);
  console.log(
    `Last refresh: ${run ? `${String(run.status)} at ${String(run.finished_at ?? run.started_at)}` : "not run yet"}`,
  );
  console.log(`Wishlist albums: ${summary.state.wishlist_items}`);
  console.log(`Pending review: ${summary.pendingReviews}`);
  console.log(`Proposed additions: ${summary.proposedAdditions}`);
  console.log(`Failures requiring attention: ${summary.recentFailures}`);
  console.log("\n1. Refresh now (read-only)");
  console.log(`2. Review pending matches (${summary.pendingReviews})`);
  console.log(`3. Preview additions (${summary.proposedAdditions})`);
  console.log("4. Apply an existing plan (writes to TIDAL)");
  console.log("5. Status and diagnostics");
  console.log("6. Setup and authorization help");
  console.log("?. Explain this screen");
  console.log("q. Quit\n");
}

async function refresh(): Promise<void> {
  console.log("\nREFRESH (READ-ONLY)");
  console.log("Step 1/3  Checking configuration");
  console.log("Step 2/3  Updating the public Bandcamp wishlist");
  console.log("Step 3/3  Reusing matches and checking the TIDAL library\n");
  console.log("Equivalent command: bandcamp-tidal-sync scan");
  const activity = service.recordActivity(
    "scan.started",
    "running",
    "Guided read-only refresh started.",
  );
  const started = Date.now();
  const result = await runner.run(["scan", "--json"], {
    databasePath,
    configPath: requestedConfig,
    onOutput(stream, text) {
      (stream === "stderr" ? process.stderr : process.stdout).write(text);
    },
  });
  if (result.exitCode !== 0) {
    service.finishActivity(activity, "failed", "Read-only refresh failed.", {
      exitCode: result.exitCode,
      error: result.stderr.slice(-2000),
    });
    console.log(
      "\nRefresh failed. The database remains available for inspection.",
    );
    return;
  }
  service.finishActivity(
    activity,
    "completed",
    "Read-only refresh completed.",
    {
      elapsedMs: Date.now() - started,
      providerWrites: 0,
    },
  );
  console.log(
    `\nElapsed: ${Math.round((Date.now() - started) / 1000)} seconds`,
  );
  console.log("Provider writes: 0");
}

async function review(input: Interface): Promise<void> {
  let records = pendingReviews();
  if (!records.length) {
    console.log("\nNo unreviewed matches need a decision.");
    return;
  }
  while (records.length && !quitting) {
    const record = records[0] as ReviewRecord;
    renderReview(record, records.length);
    const answer = (await input.question("Decision: ")).trim().toLowerCase();
    if (answer === "q" || answer === "b") break;
    if (answer === "n") {
      records.push(records.shift() as ReviewRecord);
      continue;
    }
    let action: "approved" | "rejected" | "deferred" | "unavailable";
    if (answer === "a") action = "approved";
    else if (answer === "r") action = "rejected";
    else if (answer === "d") action = "deferred";
    else if (answer === "u") action = "unavailable";
    else if (/^c\s+\d+$/.test(answer)) {
      const index = Number(answer.split(/\s+/)[1]) - 1;
      const candidate = record.candidates[index];
      if (!candidate) {
        console.log("That candidate number is not available.");
        continue;
      }
      service.reviews.decide(
        record.bandcampItemId,
        "approved",
        String(candidate.tidal_album_id),
      );
      recordReviewActivity(record, "approved");
      records = pendingReviews();
      continue;
    } else if (answer === "e") {
      const artist = (
        await input.question(`Artist [${record.artist}]: `)
      ).trim();
      const title = (await input.question(`Title [${record.title}]: `)).trim();
      const label = (await input.question(`Label [${record.label}]: `)).trim();
      service.reviews.editMetadata(record.bandcampItemId, {
        ...(artist ? { artist } : {}),
        ...(title ? { title } : {}),
        ...(label ? { label } : {}),
      });
      service.recordActivity(
        "review.updated",
        "completed",
        `Edited local metadata for ${record.artist} - ${record.title}.`,
        {
          bandcampItemId: record.bandcampItemId,
          action: "edit",
          providerWrites: 0,
        },
      );
      records = pendingReviews();
      continue;
    } else {
      console.log("Use a, c N, r, d, u, e, n, b, or q.");
      continue;
    }
    service.reviews.decide(record.bandcampItemId, action);
    recordReviewActivity(record, action);
    records = pendingReviews();
  }
  console.log("Provider writes: 0");
}

function pendingReviews(): ReviewRecord[] {
  return service.reviews
    .list()
    .filter(
      (record) =>
        !record.decision &&
        (record.status === "needs_review" ||
          record.status === "low_confidence"),
    );
}

function renderReview(record: ReviewRecord, remaining: number): void {
  console.clear();
  console.log(`REVIEW MATCH (${remaining} remaining)\n`);
  console.log(`${record.artist} - ${record.title}`);
  console.log(`Bandcamp: ${record.url}`);
  console.log(`Reason: ${record.explanation || "No explanation recorded."}`);
  console.log("\nTIDAL candidates:");
  record.candidates.forEach((candidate, index) => {
    const artists = Array.isArray(candidate.tidal_artists)
      ? candidate.tidal_artists.join(", ")
      : "Unknown artist";
    console.log(
      `${index + 1}. ${artists} - ${String(candidate.tidal_title ?? "Untitled")} (score ${String(candidate.score ?? "-")})`,
    );
  });
  console.log("\na approve best  c N choose candidate  r reject candidate");
  console.log(
    "d defer  u unavailable  e edit metadata  n next  b back  q quit",
  );
  console.log("Approve changes only the future plan. Provider writes: 0.\n");
}

function recordReviewActivity(
  record: ReviewRecord,
  action: "approved" | "rejected" | "deferred" | "unavailable",
): void {
  service.recordActivity(
    "review.updated",
    "completed",
    `${action} review decision for ${record.artist} - ${record.title}.`,
    { bandcampItemId: record.bandcampItemId, action, providerWrites: 0 },
  );
}

async function previewPlan(input: Interface): Promise<void> {
  const { plan, reused } = service.createPlan();
  console.log("\nIMMUTABLE PLAN PREVIEW\n");
  console.log(`Plan ID: ${plan.planId}`);
  console.log(`Target: ${plan.provider} collection ${plan.collection}`);
  console.log(`Current TIDAL library: ${plan.libraryCount}`);
  console.log(`Additions: ${plan.additionCount}`);
  console.log(`Status: ${reused ? "existing unchanged plan" : "new plan"}`);
  for (const [index, item] of plan.items.slice(0, 10).entries())
    console.log(`${index + 1}. ${item.artist} - ${item.title}`);
  if (plan.items.length > 10)
    console.log(`... and ${plan.items.length - 10} more`);
  const exportPath = join(config.storage.output_dir, `${plan.planId}.json`);
  mkdirSync(dirname(exportPath), { recursive: true });
  writeFileSync(exportPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  chmodSync(exportPath, 0o600);
  service.recordActivity(
    "plan.exported",
    "completed",
    `Exported immutable plan ${plan.planId}.`,
    { planId: plan.planId, exportPath, providerWrites: 0 },
  );
  console.log(`Exported: ${exportPath}`);
  console.log("Provider writes: 0");
  const answer = (
    await input.question("\nContinue to the TIDAL write confirmation? [y/N]: ")
  )
    .trim()
    .toLowerCase();
  if (answer === "y" || answer === "yes")
    await applyExactPlan(input, plan.planId);
}

async function applyPlan(input: Interface): Promise<void> {
  const plans = service.listPlans();
  if (!plans.length) {
    console.log("\nNo plans exist. Preview additions first.");
    return;
  }
  console.log("\nEXISTING PLANS\n");
  for (const plan of plans.slice(0, 10))
    console.log(
      `${String(plan.plan_id)} | ${String(plan.status)} | ${String(plan.addition_count)} additions`,
    );
  const planId = (await input.question("\nPlan ID (blank to cancel): ")).trim();
  if (planId) await applyExactPlan(input, planId);
}

async function applyExactPlan(input: Interface, planId: string): Promise<void> {
  const plan = service.getPlan(planId);
  if (!plan) {
    console.log(`Plan ${planId} was not found.`);
    return;
  }
  const payload = plan.payload as {
    additionCount?: number;
    collection?: string;
  };
  console.log("\nWRITE TO TIDAL\n");
  console.log(`Plan: ${planId}`);
  console.log(`Collection: ${payload.collection ?? "me"}`);
  console.log(`Additions: ${payload.additionCount ?? 0}`);
  console.log("This is the only guided action that may write to TIDAL.");
  const confirmation = (
    await input.question(
      `Add ${payload.additionCount ?? 0} album(s) to your TIDAL library? [y/N]: `,
    )
  )
    .trim()
    .toLowerCase();
  if (confirmation !== "y" && confirmation !== "yes") {
    console.log("Apply cancelled. Provider writes: 0.");
    return;
  }
  const activity = service.recordActivity(
    "apply.started",
    "running",
    `Apply started for plan ${planId}.`,
    { planId },
  );
  const result = await runner.run(["apply", planId, "--apply", "--yes"], {
    databasePath,
    configPath: requestedConfig,
    onOutput(stream, text) {
      (stream === "stderr" ? process.stderr : process.stdout).write(text);
    },
  });
  if (result.exitCode === 0)
    service.finishActivity(
      activity,
      "completed",
      `Apply completed for plan ${planId}.`,
      { planId },
    );
  else
    service.finishActivity(
      activity,
      "failed",
      `Apply failed for plan ${planId}.`,
      { planId, error: result.stderr.slice(-2000) },
    );
}

function diagnostics(): void {
  const summary = service.summary();
  console.log("\nSTATUS\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "\nEquivalent commands: bandcamp-tidal-sync status; bandcamp-tidal-sync doctor; bandcamp-tidal-sync logs",
  );
}

function setupHelp(): void {
  console.log("\nSETUP AND AUTHORIZATION\n");
  console.log(`Configuration: ${requestedConfig ?? configPath()}`);
  console.log(
    `Bandcamp username: ${config.providers.bandcamp.username || "not set"}`,
  );
  console.log(
    "Run `bandcamp-tidal-sync init --interactive` to configure local storage.",
  );
  console.log(
    "Run `bandcamp-tidal-sync auth status` to inspect TIDAL authorization.",
  );
  console.log(
    "Run `bandcamp-tidal-sync auth tidal` to authorize through the browser.",
  );
  console.log("Raw tokens and Bandcamp cookies are never requested here.");
}

function help(): void {
  console.log(
    "\nRefresh reads Bandcamp and TIDAL but never changes either account.",
  );
  console.log("Review decisions only update the local SQLite database.");
  console.log(
    "Plan creates an inspectable immutable proposal with zero writes.",
  );
  console.log(
    "Adding to TIDAL is separate and requires explicit confirmation.",
  );
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
