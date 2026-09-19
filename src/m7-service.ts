import type { Database } from "bun:sqlite";
import { Database as SQLiteDatabase } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config";
import { ReviewService } from "./review";
import { SyncStore } from "./sync-store";
import {
  buildWritePlan,
  persistWritePlan,
  type WritePlan,
} from "./write-orchestrator";

export type ActivityKind =
  | "scan.started"
  | "scan.completed"
  | "scan.failed"
  | "review.updated"
  | "plan.created"
  | "plan.exported"
  | "apply.started"
  | "apply.completed"
  | "apply.failed"
  | "backup.created"
  | "backup.restored"
  | "report.exported"
  | "schedule.updated"
  | "notification.updated"
  | "notification.delivered"
  | "notification.failed";

export interface ActivityRecord {
  id: number;
  kind: ActivityKind;
  status: "running" | "completed" | "failed";
  createdAt: string;
  finishedAt: string | null;
  summary: string;
  details: Record<string, unknown>;
}

export interface ScheduleState {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface NotificationState {
  enabled: boolean;
  configured: boolean;
  target: string | null;
}

export interface DashboardSummary {
  database: string;
  initialized: boolean;
  state: Record<string, number>;
  lastRun: Record<string, unknown> | null;
  pendingReviews: number;
  proposedAdditions: number;
  latestPlan: Record<string, unknown> | null;
  recentFailures: number;
  schedule: ScheduleState;
  providerWrites: 0;
}

export class M7Service {
  readonly reviews: ReviewService;
  readonly store: SyncStore;

  constructor(
    private readonly database: Database,
    readonly databasePath: string,
    readonly config: AppConfig,
  ) {
    this.store = new SyncStore(database);
    this.reviews = new ReviewService(database);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS schedule_settings (
        schedule_id INTEGER PRIMARY KEY CHECK (schedule_id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT 1440,
        next_run_at TEXT,
        last_run_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schedule_settings
        (schedule_id, enabled, interval_minutes, updated_at)
      VALUES (1, 0, 1440, CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS notification_settings (
        notification_id INTEGER PRIMARY KEY CHECK (notification_id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        webhook_url TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO notification_settings
        (notification_id, enabled, webhook_url, updated_at)
      VALUES (1, 0, NULL, CURRENT_TIMESTAMP);
    `);
  }

  summary(): DashboardSummary {
    const state = this.store.summary();
    const lastRun = this.database
      .query("SELECT * FROM sync_runs ORDER BY run_id DESC LIMIT 1")
      .get() as Record<string, unknown> | null;
    const latestPlan = this.database
      .query(
        `SELECT plan_id, created_at, provider, collection, status,
                (SELECT count(*) FROM write_plan_items i WHERE i.plan_id = p.plan_id) AS addition_count
         FROM write_plans p ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | null;
    const pendingReviews = this.reviews
      .list()
      .filter(
        (record) =>
          !record.decision &&
          (record.status === "needs_review" ||
            record.status === "low_confidence"),
      ).length;
    const recentFailures = this.unresolvedFailureCount();
    return {
      database: this.databasePath,
      initialized: Boolean(lastRun) || (state.wishlist_items ?? 0) > 0,
      state,
      lastRun,
      pendingReviews,
      proposedAdditions: this.reviews.pendingPlan().additionCount,
      latestPlan,
      recentFailures,
      schedule: this.schedule(),
      providerWrites: 0,
    };
  }

  private unresolvedFailureCount(): number {
    const events = this.database
      .query(
        `SELECT event_id, kind, status, details_json
         FROM activity_events ORDER BY event_id`,
      )
      .all() as Array<{
      event_id: number;
      kind: string;
      status: string;
      details_json: string;
    }>;
    const completedPlans = new Set(
      (
        this.database
          .query("SELECT plan_id FROM write_plans WHERE status = 'completed'")
          .all() as Array<{ plan_id: string }>
      ).map((row) => row.plan_id),
    );
    const lastCompletedScan = events
      .filter(
        (event) =>
          event.kind === "scan.started" && event.status === "completed",
      )
      .at(-1)?.event_id;
    const lastDeliveredNotification = events
      .filter(
        (event) =>
          event.kind === "notification.delivered" &&
          event.status === "completed",
      )
      .at(-1)?.event_id;
    return events.filter((event) => {
      if (event.status !== "failed") return false;
      if (event.kind === "scan.started" && lastCompletedScan)
        return event.event_id > lastCompletedScan;
      if (event.kind === "notification.failed" && lastDeliveredNotification)
        return event.event_id > lastDeliveredNotification;
      if (event.kind === "apply.started") {
        const details = safeObject(event.details_json);
        const planId =
          typeof details.planId === "string" ? details.planId : null;
        if (planId && completedPlans.has(planId)) return false;
      }
      return true;
    }).length;
  }

  createPlan(createdAt = new Date().toISOString()): {
    plan: WritePlan;
    reused: boolean;
  } {
    const plan = buildWritePlan(this.reviews, this.config, createdAt);
    const latest = this.database
      .query(
        "SELECT status, payload_json FROM write_plans ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { status: string; payload_json: string } | null;
    if (latest?.status === "proposed") {
      const previous = JSON.parse(latest.payload_json) as WritePlan;
      if (samePlanContents(previous, plan))
        return { plan: previous, reused: true };
    }
    const existing = this.store.getWritePlan(plan.planId);
    if (existing) return { plan: existing.payload as WritePlan, reused: true };
    persistWritePlan(this.store, plan);
    this.recordActivity(
      "plan.created",
      "completed",
      `Created immutable plan with ${plan.additionCount} addition(s).`,
      { planId: plan.planId, additionCount: plan.additionCount },
    );
    return { plan, reused: false };
  }

  listPlans(): Array<Record<string, unknown>> {
    return this.database
      .query(
        `SELECT p.plan_id, p.created_at, p.provider, p.collection, p.status,
                count(i.position) AS addition_count
         FROM write_plans p
         LEFT JOIN write_plan_items i ON i.plan_id = p.plan_id
         GROUP BY p.plan_id ORDER BY p.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  getPlan(planId: string): Record<string, unknown> | null {
    const plan = this.store.getWritePlan(planId);
    if (!plan) return null;
    return { ...plan, attempts: this.store.listWriteAttempts(planId) };
  }

  recordActivity(
    kind: ActivityKind,
    status: ActivityRecord["status"],
    summary: string,
    details: Record<string, unknown> = {},
    createdAt = new Date().toISOString(),
  ): number {
    const row = this.database
      .query(
        `INSERT INTO activity_events
          (kind, status, created_at, finished_at, summary, details_json)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING event_id`,
      )
      .get(
        kind,
        status,
        createdAt,
        status === "running" ? null : createdAt,
        summary,
        JSON.stringify(redactSensitive(details)),
      ) as { event_id: number };
    return Number(row.event_id);
  }

  finishActivity(
    id: number,
    status: "completed" | "failed",
    summary: string,
    details: Record<string, unknown> = {},
  ): void {
    this.database
      .query(
        `UPDATE activity_events
         SET status = ?, finished_at = ?, summary = ?, details_json = ?
         WHERE event_id = ?`,
      )
      .run(
        status,
        new Date().toISOString(),
        summary,
        JSON.stringify(redactSensitive(details)),
        id,
      );
  }

  activities(limit = 50): ActivityRecord[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database
      .query(
        `SELECT event_id, kind, status, created_at, finished_at, summary, details_json
         FROM activity_events ORDER BY event_id DESC LIMIT ?`,
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.event_id),
      kind: String(row.kind) as ActivityKind,
      status: String(row.status) as ActivityRecord["status"],
      createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      summary: String(row.summary),
      details: JSON.parse(String(row.details_json)) as Record<string, unknown>,
    }));
  }

  schedule(): ScheduleState {
    const row = this.database
      .query("SELECT * FROM schedule_settings WHERE schedule_id = 1")
      .get() as Record<string, unknown>;
    return {
      enabled: Boolean(row.enabled),
      intervalMinutes: Number(row.interval_minutes),
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    };
  }

  updateSchedule(enabled: boolean, intervalMinutes: number): ScheduleState {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5)
      throw new Error("Schedule interval must be at least 5 minutes.");
    const now = new Date();
    const next = enabled
      ? new Date(now.getTime() + intervalMinutes * 60_000).toISOString()
      : null;
    this.database
      .query(
        `UPDATE schedule_settings
         SET enabled = ?, interval_minutes = ?, next_run_at = ?, updated_at = ?
         WHERE schedule_id = 1`,
      )
      .run(enabled ? 1 : 0, intervalMinutes, next, now.toISOString());
    this.recordActivity(
      "schedule.updated",
      "completed",
      enabled
        ? `Scheduled read-only refresh every ${intervalMinutes} minutes.`
        : "Scheduled refresh paused.",
      { enabled, intervalMinutes, nextRunAt: next },
    );
    return this.schedule();
  }

  notification(): NotificationState {
    const row = this.database
      .query(
        "SELECT enabled, webhook_url FROM notification_settings WHERE notification_id = 1",
      )
      .get() as { enabled: number; webhook_url: string | null };
    return {
      enabled: Boolean(row.enabled),
      configured: Boolean(row.webhook_url),
      target: row.webhook_url ? new URL(row.webhook_url).host : null,
    };
  }

  updateNotification(enabled: boolean, webhookUrl?: string): NotificationState {
    const current = this.database
      .query(
        "SELECT webhook_url FROM notification_settings WHERE notification_id = 1",
      )
      .get() as { webhook_url: string | null };
    const nextUrl = webhookUrl?.trim()
      ? validateWebhookUrl(webhookUrl.trim())
      : current.webhook_url;
    if (enabled && !nextUrl)
      throw new Error(
        "A webhook URL is required before notifications can be enabled.",
      );
    this.database
      .query(
        `UPDATE notification_settings
         SET enabled = ?, webhook_url = ?, updated_at = ?
         WHERE notification_id = 1`,
      )
      .run(enabled ? 1 : 0, nextUrl, new Date().toISOString());
    this.recordActivity(
      "notification.updated",
      "completed",
      enabled
        ? "Webhook notifications enabled."
        : "Webhook notifications disabled.",
      { enabled, target: nextUrl ? new URL(nextUrl).host : null },
    );
    return this.notification();
  }

  webhookUrl(): string | null {
    const row = this.database
      .query(
        "SELECT enabled, webhook_url FROM notification_settings WHERE notification_id = 1",
      )
      .get() as { enabled: number; webhook_url: string | null };
    return row.enabled ? row.webhook_url : null;
  }

  markScheduledRun(): ScheduleState {
    const schedule = this.schedule();
    const now = new Date();
    const next = schedule.enabled
      ? new Date(
          now.getTime() + schedule.intervalMinutes * 60_000,
        ).toISOString()
      : null;
    this.database
      .query(
        `UPDATE schedule_settings
         SET last_run_at = ?, next_run_at = ?, updated_at = ?
         WHERE schedule_id = 1`,
      )
      .run(now.toISOString(), next, now.toISOString());
    return this.schedule();
  }

  createBackup(targetPath: string): string {
    if (this.databasePath === ":memory:")
      throw new Error("An in-memory database cannot be backed up to a file.");
    mkdirSync(dirname(targetPath), { recursive: true });
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    copyFileSync(this.databasePath, targetPath);
    chmodSync(targetPath, 0o600);
    this.recordActivity(
      "backup.created",
      "completed",
      "Created local database backup.",
      { targetPath },
    );
    return targetPath;
  }

  health(activeOperation: string | null = null): {
    status: "ok" | "busy";
    ready: boolean;
    activeOperation: string | null;
    database: string;
  } {
    this.database.query("SELECT 1").get();
    return {
      status: activeOperation ? "busy" : "ok",
      ready: !activeOperation,
      activeOperation,
      database: this.databasePath,
    };
  }
}

export interface RestoreResult {
  sourcePath: string;
  targetPath: string;
  replaced: boolean;
  recoveryBackup: string | null;
}

export function inspectDatabaseBackup(path: string): {
  path: string;
  integrity: "ok";
  tables: string[];
} {
  const sourcePath = resolve(path);
  if (!existsSync(sourcePath))
    throw new Error(`Backup does not exist: ${sourcePath}`);
  const database = new SQLiteDatabase(sourcePath, { readonly: true });
  try {
    const integrity = database.query("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    if (integrity.quick_check !== "ok")
      throw new Error(
        `Backup integrity check failed: ${integrity.quick_check}`,
      );
    const tables = (
      database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const required = ["bandcamp_items", "match_decisions", "sync_runs"];
    const missing = required.filter((name) => !tables.includes(name));
    if (missing.length)
      throw new Error(
        `Backup is not a Bandcamp to TIDAL database (missing: ${missing.join(", ")}).`,
      );
    return { path: sourcePath, integrity: "ok", tables };
  } finally {
    database.close();
  }
}

export function restoreDatabaseBackup(
  source: string,
  target: string,
  options: { replace?: boolean; now?: Date } = {},
): RestoreResult {
  const sourcePath = resolve(source);
  const targetPath = resolve(target);
  if (sourcePath === targetPath)
    throw new Error(
      "Backup source and restore target must be different files.",
    );
  inspectDatabaseBackup(sourcePath);
  const replaced = existsSync(targetPath);
  if (replaced && !options.replace)
    throw new Error(
      `Restore target already exists: ${targetPath} (use --replace after reviewing both paths).`,
    );
  mkdirSync(dirname(targetPath), { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().replaceAll(":", "-");
  const recoveryBackup = replaced
    ? `${targetPath}.before-restore-${stamp}.sqlite`
    : null;
  const temporary = `${targetPath}.restore-${process.pid}-${Date.now()}.tmp`;
  try {
    if (recoveryBackup) {
      copyFileSync(targetPath, recoveryBackup);
      chmodSync(recoveryBackup, 0o600);
    }
    copyFileSync(sourcePath, temporary);
    chmodSync(temporary, 0o600);
    inspectDatabaseBackup(temporary);
    renameSync(temporary, targetPath);
    chmodSync(targetPath, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
  return { sourcePath, targetPath, replaced, recoveryBackup };
}

export function redactSensitive(value: unknown, key = ""): unknown {
  if (
    /^(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|oauth[_-]?code|webhook[_-]?url)$/i.test(
      key,
    )
  )
    return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitive(entryValue, entryKey),
      ]),
    );
  if (typeof value === "string")
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(
        /([?&](?:access_token|refresh_token|code)=)[^&\s]+/gi,
        "$1[REDACTED]",
      );
  return value;
}

function samePlanContents(left: WritePlan, right: WritePlan): boolean {
  return (
    left.libraryCount === right.libraryCount &&
    left.maxAdditions === right.maxAdditions &&
    JSON.stringify(
      left.items.map((item) => [item.bandcampItemId, item.tidalAlbumId]),
    ) ===
      JSON.stringify(
        right.items.map((item) => [item.bandcampItemId, item.tidalAlbumId]),
      )
  );
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Webhook URL is invalid.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(
      "Webhook URL must use HTTPS (HTTP is allowed only on loopback).",
    );
  if (url.username || url.password)
    throw new Error("Webhook URL must not contain embedded credentials.");
  return url.toString();
}

function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
