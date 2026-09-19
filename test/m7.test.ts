import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import {
  M7Service,
  redactSensitive,
  restoreDatabaseBackup,
} from "../src/m7-service";
import { createReviewHandler, DashboardRuntime } from "../src/review-server";
import { SyncStore } from "../src/sync-store";

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

function prepared(): {
  database: Database;
  service: M7Service;
  runtime: DashboardRuntime;
} {
  const database = new Database(":memory:");
  databases.push(database);
  const config = defaultConfig();
  const service = new M7Service(database, ":memory:", config);
  const store = new SyncStore(database);
  store.importMatches([
    {
      bandcamp_item_id: 7,
      bandcamp_artist: "Fixture Artist",
      bandcamp_title: "Fixture Album",
      bandcamp_url: "https://fixture.bandcamp.com/album/fixture",
      status: "needs_review",
      best_match: {
        tidal_album_id: "t1",
        tidal_title: "Fixture Album",
        tidal_artists: ["Fixture Artist"],
        score: 88,
      },
      candidates: [
        {
          tidal_album_id: "t1",
          tidal_title: "Fixture Album",
          tidal_artists: ["Fixture Artist"],
          score: 88,
        },
      ],
    },
  ]);
  store.importLibrarySnapshot([]);
  return { database, service, runtime: new DashboardRuntime(service) };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  // File-backed databases created inside a test can be finalized after their
  // explicit close on Windows. Release those native handles before cleanup.
  if (process.platform === "win32") Bun.gc(true);
  for (const directory of temporaryDirectories.splice(0))
    removeTemporaryDirectory(directory);
});

function removeTemporaryDirectory(directory: string): void {
  // Windows can release a closed SQLite handle noticeably after the test ends.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      if (process.platform !== "win32" || attempt === 9) throw error;
      Bun.sleepSync(250 * (attempt + 1));
    }
  }
}

describe("M7 operations", () => {
  test("builds a dashboard summary without provider writes", () => {
    const { service } = prepared();
    expect(service.summary()).toMatchObject({
      pendingReviews: 1,
      proposedAdditions: 0,
      providerWrites: 0,
      schedule: { enabled: false, intervalMinutes: 1440 },
    });
    expect(service.health()).toMatchObject({ status: "ok", ready: true });
  });

  test("reuses an unchanged proposed plan across different timestamps", () => {
    const { service } = prepared();
    service.reviews.decide(7, "approved", "t1");
    const first = service.createPlan("2026-09-18T10:00:00.000Z");
    const second = service.createPlan("2026-09-18T11:00:00.000Z");
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.plan.planId).toBe(first.plan.planId);
    expect(service.listPlans()).toHaveLength(1);
  });

  test("persists activity and validates read-only schedules", () => {
    const { service } = prepared();
    const event = service.recordActivity(
      "scan.started",
      "running",
      "Fixture scan",
    );
    service.finishActivity(event, "completed", "Fixture scan complete", {
      providerWrites: 0,
    });
    expect(service.activities()).toMatchObject([
      {
        kind: "scan.started",
        status: "completed",
        details: { providerWrites: 0 },
      },
    ]);
    expect(() => service.updateSchedule(true, 1)).toThrow("at least 5");
    expect(service.updateSchedule(true, 15)).toMatchObject({
      enabled: true,
      intervalMinutes: 15,
    });
    expect(() =>
      service.updateNotification(true, "http://example.com/hook"),
    ).toThrow("HTTPS");
    expect(
      service.updateNotification(true, "https://example.com/hook"),
    ).toMatchObject({ enabled: true, configured: true, target: "example.com" });
  });

  test("counts only failures that still need attention", () => {
    const { service } = prepared();
    service.recordActivity("scan.started", "failed", "Expired token");
    expect(service.summary().recentFailures).toBe(1);
    service.recordActivity("scan.started", "completed", "Refresh complete");
    expect(service.summary().recentFailures).toBe(0);

    service.reviews.decide(7, "approved", "t1");
    const planId = service.createPlan().plan.planId;
    service.recordActivity("apply.started", "failed", "Verification failed", {
      planId,
    });
    expect(service.summary().recentFailures).toBe(1);
    service.store.setWritePlanStatus(planId, "completed");
    expect(service.summary().recentFailures).toBe(0);
  });

  test("dashboard endpoints expose summary and protect mutations", async () => {
    const { service, runtime } = prepared();
    const handler = createReviewHandler(
      service.reviews,
      "session",
      "csrf",
      undefined,
      ["127.0.0.1"],
      runtime,
    );
    const summary = await handler(
      new Request("http://127.0.0.1/api/dashboard", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ providerWrites: 0 });

    const rejected = await handler(
      new Request("http://127.0.0.1/api/plans", {
        method: "POST",
        headers: { Host: "127.0.0.1" },
        body: "{}",
      }),
    );
    expect(rejected.status).toBe(403);

    const invalidApply = await handler(
      new Request("http://127.0.0.1/api/plans/missing/apply", {
        method: "POST",
        headers: {
          Host: "127.0.0.1",
          Cookie: "bcts_session=session",
          "X-CSRF-Token": "csrf",
        },
        body: JSON.stringify({ confirmation: "no" }),
      }),
    );
    expect(invalidApply.status).toBe(400);
  });

  test("readiness distinguishes an active operation from idle health", async () => {
    const { service } = prepared();
    const runner = {
      active: true,
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const handler = createReviewHandler(
      service.reviews,
      "session",
      "csrf",
      undefined,
      ["127.0.0.1"],
      new DashboardRuntime(service, undefined, runner),
    );
    const health = await handler(
      new Request("http://127.0.0.1/api/health", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "busy", ready: false });
    const ready = await handler(
      new Request("http://127.0.0.1/api/ready", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(ready.status).toBe(503);
  });

  test("records review and export actions without exposing secrets", async () => {
    const { service, runtime } = prepared();
    const handler = createReviewHandler(
      service.reviews,
      "session",
      "csrf",
      undefined,
      ["127.0.0.1"],
      runtime,
    );
    const mutationHeaders = {
      Host: "127.0.0.1",
      Cookie: "bcts_session=session",
      "X-CSRF-Token": "csrf",
    };
    const decision = await handler(
      new Request("http://127.0.0.1/api/reviews/7", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ action: "approved", candidateId: "t1" }),
      }),
    );
    expect(decision.status).toBe(200);
    const created = await handler(
      new Request("http://127.0.0.1/api/plans", {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
      }),
    );
    const planId = String((await created.json()).plan.planId);
    const exported = await handler(
      new Request(
        `http://127.0.0.1/api/plans/${encodeURIComponent(planId)}?download=1`,
        { headers: { Host: "127.0.0.1" } },
      ),
    );
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const report = await handler(
      new Request("http://127.0.0.1/api/report", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    expect(report.headers.get("content-disposition")).toContain("attachment");
    expect(service.activities().map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "review.updated",
        "plan.created",
        "plan.exported",
        "report.exported",
      ]),
    );
    expect(
      redactSensitive({
        authorization: "Bearer visible-token",
        nested: { access_token: "visible-token" },
        error: "request?code=visible-code&ok=1",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
      error: "request?code=[REDACTED]&ok=1",
    });
  });

  test("restores a validated backup and preserves the replaced database", () => {
    const directory = mkdtempSync(join(tmpdir(), "bcts-m7-restore-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const targetPath = join(directory, "target.sqlite");
    const source = new Database(sourcePath);
    const sourceService = new M7Service(source, sourcePath, defaultConfig());
    sourceService.store.importMatches([
      {
        bandcamp_item_id: 77,
        bandcamp_artist: "Backup Artist",
        bandcamp_title: "Backup Album",
        bandcamp_url: "https://example.invalid/backup",
        status: "needs_review",
        best_match: null,
        candidates: [],
      },
    ]);
    sourceService.createBackup(backupPath);
    source.close();

    const first = restoreDatabaseBackup(backupPath, targetPath);
    expect(first.replaced).toBe(false);
    const oldTarget = new Database(targetPath);
    oldTarget.query("DELETE FROM match_decisions").run();
    oldTarget.close();
    const second = restoreDatabaseBackup(backupPath, targetPath, {
      replace: true,
      now: new Date("2026-09-18T12:00:00.000Z"),
    });
    expect(second.replaced).toBe(true);
    expect(second.recoveryBackup && existsSync(second.recoveryBackup)).toBe(
      true,
    );
    const restored = new Database(targetPath, { readonly: true });
    expect(
      (
        restored
          .query("SELECT count(*) AS count FROM match_decisions")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    restored.close();
  });

  test("runs guarded apply through a mocked runner only after confirmation", async () => {
    const { service } = prepared();
    service.reviews.decide(7, "approved", "t1");
    const planId = service.createPlan().plan.planId;
    const calls: Array<{ command: string[]; input?: string }> = [];
    const runner = {
      active: false,
      async run(command: string[], options: { input?: string }) {
        calls.push({ command, input: options.input });
        return { exitCode: 0, stdout: "mocked", stderr: "" };
      },
    };
    const runtime = new DashboardRuntime(service, undefined, runner);
    const handler = createReviewHandler(
      service.reviews,
      "session",
      "csrf",
      undefined,
      ["127.0.0.1"],
      runtime,
    );
    const response = await handler(
      new Request(`http://127.0.0.1/api/plans/${planId}/apply`, {
        method: "POST",
        headers: {
          Host: "127.0.0.1",
          Cookie: "bcts_session=session",
          "X-CSRF-Token": "csrf",
        },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    expect(response.status).toBe(202);
    await Bun.sleep(5);
    expect(calls).toEqual([
      {
        command: ["apply", planId, "--apply", "--yes"],
        input: undefined,
      },
    ]);
    expect(service.activities()[0]).toMatchObject({
      kind: "apply.started",
      status: "completed",
    });
  });

  test("delivers opt-in scheduled summaries without private metadata", async () => {
    const { service } = prepared();
    service.updateNotification(true, "https://example.com/hook?secret=unused");
    const deliveries: Array<{ url: string; body: string }> = [];
    const runner = {
      active: false,
      async run() {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    };
    const runtime = new DashboardRuntime(
      service,
      undefined,
      runner,
      async (input, init) => {
        deliveries.push({ url: String(input), body: String(init?.body) });
        return new Response(null, { status: 204 });
      },
    );
    runtime.startScan(undefined, true);
    await Bun.sleep(10);
    const delivered = deliveries[0];
    expect(delivered?.url).toBe("https://example.com/hook?secret=unused");
    expect(JSON.parse(delivered?.body ?? "{}")).toMatchObject({
      event: "bcts.scan.completed",
      providerWrites: 0,
    });
    expect(delivered?.body).not.toContain("Fixture Artist");
    expect(service.activities()[0]).toMatchObject({
      kind: "notification.delivered",
      status: "completed",
      details: { target: "example.com" },
    });
  });

  test("guided mode rejects non-interactive input instead of hanging", () => {
    const result = Bun.spawnSync(
      [process.execPath, "run", "scripts/main.ts", "guided"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Guided mode requires an interactive terminal",
    );
  });

  test("rejects a redundant sync prefix without running synchronization", () => {
    const directory = mkdtempSync(join(tmpdir(), "bcts-m7-command-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "must-not-exist.sqlite");
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "scripts/main.ts",
        "sync",
        "auth",
        "--database",
        databasePath,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unknown command: sync");
    expect(result.stderr.toString()).toContain(
      "Use `bandcamp-tidal-sync auth tidal`",
    );
    expect(existsSync(databasePath)).toBe(false);
  });
});
