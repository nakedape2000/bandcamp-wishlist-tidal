import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { M7OperationRunner } from "./m7-runner";
import { M7Service, redactSensitive } from "./m7-service";
import { type ReviewAction, ReviewService } from "./review";

const ROOT = join(import.meta.dir, "..", "web", "review");
type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createReviewHandler(
  reviews: ReviewService,
  sessionToken: string,
  csrfToken: string,
  resolveTidalArtwork = createTidalArtworkResolver(),
  allowedHosts = ["127.0.0.1", "localhost", "[::1]"],
  runtime?: DashboardRuntime,
): (request: Request) => Promise<Response> {
  const allowedHostnames = new Set(
    allowedHosts.map(canonicalHost).filter(Boolean),
  );
  return async (request) => {
    const requestHost = request.headers.get("host");
    if (!requestHost || !allowedHostnames.has(canonicalHost(requestHost)))
      return new Response("Invalid host", { status: 421 });
    const url = new URL(request.url);
    const headers = securityHeaders();

    if (url.pathname === "/api/session" && request.method === "GET") {
      headers.set(
        "Set-Cookie",
        `bcts_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return json({ csrfToken }, 200, headers);
    }

    if (runtime) {
      const dashboardResponse = await runtime.handle(
        request,
        url,
        headers,
        () => authorizedMutation(request, sessionToken, csrfToken),
      );
      if (dashboardResponse) return dashboardResponse;
    }

    if (url.pathname === "/api/reviews" && request.method === "GET") {
      const records = reviews.list({
        status: url.searchParams.get("status") ?? undefined,
        artist: url.searchParams.get("artist") ?? undefined,
        label: url.searchParams.get("label") ?? undefined,
        minScore: numberParam(url, "minScore"),
        maxScore: numberParam(url, "maxScore"),
        since: url.searchParams.get("since") ?? undefined,
      });
      return json({ records, total: records.length }, 200, headers);
    }

    if (url.pathname === "/api/pending" && request.method === "GET") {
      return json(reviews.pendingPlan(), 200, headers);
    }

    const artworkMatch = url.pathname.match(/^\/api\/artwork\/tidal\/(\d+)$/);
    if (artworkMatch && request.method === "GET") {
      const artworkUrl = await resolveTidalArtwork(artworkMatch[1] as string);
      if (!artworkUrl)
        return json({ error: "Artwork not found" }, 404, headers);
      headers.set("Location", artworkUrl);
      return new Response(null, { status: 302, headers });
    }

    const match = url.pathname.match(/^\/api\/reviews\/(\d+)$/);
    if (match && request.method === "GET") {
      const record = reviews.get(Number(match[1]));
      return record
        ? json(record, 200, headers)
        : json({ error: "Not found" }, 404, headers);
    }

    if (match && request.method === "POST") {
      if (!authorizedMutation(request, sessionToken, csrfToken))
        return json({ error: "Invalid session or CSRF token" }, 403, headers);
      try {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > 16_384)
          return json({ error: "Request body too large" }, 413, headers);
        const body = JSON.parse(rawBody) as {
          action?: ReviewAction | "edit";
          candidateId?: string;
          metadata?: Record<string, string>;
        };
        const id = Number(match[1]);
        const decision =
          body.action === "edit"
            ? reviews.editMetadata(id, body.metadata ?? {})
            : reviews.decide(id, body.action as ReviewAction, body.candidateId);
        runtime?.recordReviewUpdate(id, body.action ?? "unknown");
        return json({ decision, providerWrites: 0 }, 200, headers);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
          headers,
        );
      }
    }

    const assets: Record<string, [string, string]> = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    };
    const asset = assets[url.pathname];
    if (asset) {
      headers.set("Content-Type", asset[1]);
      return new Response(Bun.file(join(ROOT, asset[0])), { headers });
    }
    return new Response("Not found", { status: 404, headers });
  };
}

export class DashboardRuntime {
  private operation: {
    kind: "scan" | "apply";
    startedAt: string;
    message: string;
  } | null = null;

  constructor(
    readonly service: M7Service,
    private readonly configPath?: string,
    readonly runner: Pick<
      M7OperationRunner,
      "active" | "run"
    > = new M7OperationRunner(),
    private readonly fetcher: Fetcher = fetch,
  ) {}

  recordReviewUpdate(itemId: number, action: string): void {
    this.service.recordActivity(
      "review.updated",
      "completed",
      `Saved ${action} review action for item ${itemId}.`,
      { itemId, action, providerWrites: 0 },
    );
  }

  private get busy(): boolean {
    return this.operation !== null || this.runner.active;
  }

  async handle(
    request: Request,
    url: URL,
    headers: Headers,
    authorized: () => boolean,
  ): Promise<Response | null> {
    if (url.pathname === "/api/dashboard" && request.method === "GET")
      return json(
        {
          ...this.service.summary(),
          activeOperation:
            this.operation ??
            (this.runner.active
              ? {
                  kind: "operation",
                  startedAt: null,
                  message: "Operation in progress",
                }
              : null),
        },
        200,
        headers,
      );
    if (url.pathname === "/api/activity" && request.method === "GET")
      return json(
        { records: this.service.activities(numberParam(url, "limit") ?? 50) },
        200,
        headers,
      );
    if (url.pathname === "/api/health" && request.method === "GET")
      return json(
        this.service.health(this.busy ? "running" : null),
        200,
        headers,
      );
    if (url.pathname === "/api/ready" && request.method === "GET") {
      try {
        const health = this.service.health(this.busy ? "running" : null);
        return json(health, health.ready ? 200 : 503, headers);
      } catch (error) {
        return json({ ready: false, error: message(error) }, 503, headers);
      }
    }
    if (url.pathname === "/api/plans" && request.method === "GET")
      return json({ records: this.service.listPlans() }, 200, headers);
    const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/);
    if (planMatch && request.method === "GET") {
      const planId = decodeURIComponent(planMatch[1] ?? "");
      const plan = this.service.getPlan(planId);
      if (!plan) return json({ error: "Plan not found" }, 404, headers);
      if (url.searchParams.get("download") === "1") {
        headers.set(
          "Content-Disposition",
          `attachment; filename="${safeFilename(planId)}.json"`,
        );
        this.service.recordActivity(
          "plan.exported",
          "completed",
          `Exported immutable plan ${planId}.`,
          { planId, providerWrites: 0 },
        );
      }
      return json(redactSensitive(plan), 200, headers);
    }
    if (url.pathname === "/api/schedule" && request.method === "GET")
      return json(this.service.schedule(), 200, headers);
    if (url.pathname === "/api/notifications" && request.method === "GET")
      return json(this.service.notification(), 200, headers);
    if (url.pathname === "/api/report" && request.method === "GET") {
      headers.set(
        "Content-Disposition",
        'attachment; filename="bcts-activity-report.json"',
      );
      const report = redactSensitive({
        schema_version: 1,
        exported_at: new Date().toISOString(),
        summary: this.service.summary(),
        activity: this.service.activities(200),
        plans: this.service.listPlans(),
      });
      this.service.recordActivity(
        "report.exported",
        "completed",
        "Exported dashboard activity report.",
        { providerWrites: 0 },
      );
      return json(report, 200, headers);
    }

    if (
      [
        "/api/operations/scan",
        "/api/plans",
        "/api/schedule",
        "/api/notifications",
        "/api/backup",
      ].includes(url.pathname) &&
      request.method === "POST"
    ) {
      if (!authorized())
        return json({ error: "Invalid session or CSRF token" }, 403, headers);
      try {
        if (url.pathname === "/api/operations/scan")
          return this.startScan(headers);
        if (url.pathname === "/api/plans") {
          const result = this.service.createPlan();
          return json(
            { ...result, providerWrites: 0 },
            result.reused ? 200 : 201,
            headers,
          );
        }
        if (url.pathname === "/api/schedule") {
          const body = await readJsonBody(request);
          return json(
            this.service.updateSchedule(
              body.enabled === true,
              Number(body.intervalMinutes),
            ),
            200,
            headers,
          );
        }
        if (url.pathname === "/api/notifications") {
          const body = await readJsonBody(request);
          return json(
            this.service.updateNotification(
              body.enabled === true,
              typeof body.webhookUrl === "string" ? body.webhookUrl : undefined,
            ),
            200,
            headers,
          );
        }
        const path = join(
          this.service.config.storage.output_dir,
          "backups",
          `bcts-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
        );
        return json(
          { path: this.service.createBackup(path), credentialsIncluded: false },
          201,
          headers,
        );
      } catch (error) {
        return json({ error: message(error) }, 400, headers);
      }
    }

    const applyMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/apply$/);
    if (applyMatch && request.method === "POST") {
      if (!authorized())
        return json({ error: "Invalid session or CSRF token" }, 403, headers);
      try {
        const planId = decodeURIComponent(applyMatch[1] ?? "");
        const body = await readJsonBody(request);
        if (body.confirmed !== true)
          return json(
            {
              error:
                "Confirm that the displayed albums should be added to TIDAL.",
            },
            400,
            headers,
          );
        return this.startApply(planId, headers);
      } catch (error) {
        return json({ error: message(error) }, 400, headers);
      }
    }
    return null;
  }

  startScan(headers = securityHeaders(), scheduled = false): Response {
    if (this.busy)
      return json(
        { error: "Another operation is already running." },
        409,
        headers,
      );
    const activity = this.service.recordActivity(
      "scan.started",
      "running",
      "Dashboard read-only refresh started.",
    );
    this.operation = {
      kind: "scan",
      startedAt: new Date().toISOString(),
      message: "Starting read-only refresh",
    };
    void this.runner
      .run(["scan", "--json"], {
        databasePath: this.service.databasePath,
        configPath: this.configPath,
        onOutput: (_stream, text) => this.updateProgress(text),
      })
      .then((result) => {
        if (result.exitCode === 0)
          this.service.finishActivity(
            activity,
            "completed",
            "Dashboard read-only refresh completed.",
            { providerWrites: 0, output: safeJson(result.stdout) },
          );
        else
          this.service.finishActivity(
            activity,
            "failed",
            "Dashboard read-only refresh failed.",
            { error: result.stderr.slice(-2000) },
          );
        if (scheduled)
          void this.sendScheduledNotification(result.exitCode === 0);
      })
      .catch((error) => {
        this.service.finishActivity(
          activity,
          "failed",
          "Dashboard read-only refresh failed.",
          { error: message(error) },
        );
        if (scheduled) void this.sendScheduledNotification(false);
      })
      .finally(() => {
        this.operation = null;
      });
    return json(
      { activityId: activity, status: "running", providerWrites: 0 },
      202,
      headers,
    );
  }

  private async sendScheduledNotification(ok: boolean): Promise<void> {
    const url = this.service.webhookUrl();
    if (!url) return;
    const summary = this.service.summary();
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "bcts.scan.completed",
          ok,
          completedAt: new Date().toISOString(),
          counts: {
            wishlist: summary.state.wishlist_items,
            pendingReview: summary.pendingReviews,
            proposedAdditions: summary.proposedAdditions,
            failures: summary.recentFailures,
          },
          providerWrites: 0,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.service.recordActivity(
        "notification.delivered",
        "completed",
        "Scheduled refresh notification delivered.",
        { target: new URL(url).host },
      );
    } catch (error) {
      this.service.recordActivity(
        "notification.failed",
        "failed",
        "Scheduled refresh notification failed.",
        { target: new URL(url).host, error: message(error) },
      );
    }
  }

  startApply(planId: string, headers = securityHeaders()): Response {
    if (this.busy)
      return json(
        { error: "Another operation is already running." },
        409,
        headers,
      );
    if (!this.service.getPlan(planId))
      return json({ error: "Plan not found" }, 404, headers);
    const activity = this.service.recordActivity(
      "apply.started",
      "running",
      `Dashboard apply started for plan ${planId}.`,
      { planId },
    );
    this.operation = {
      kind: "apply",
      startedAt: new Date().toISOString(),
      message: `Starting apply for ${planId}`,
    };
    void this.runner
      .run(["apply", planId, "--apply", "--yes"], {
        databasePath: this.service.databasePath,
        configPath: this.configPath,
        onOutput: (_stream, text) => this.updateProgress(text),
      })
      .then((result) =>
        this.service.finishActivity(
          activity,
          result.exitCode === 0 ? "completed" : "failed",
          result.exitCode === 0
            ? `Apply completed for plan ${planId}.`
            : `Apply failed for plan ${planId}.`,
          {
            planId,
            output: result.stdout.slice(-4000),
            error: result.stderr.slice(-2000),
          },
        ),
      )
      .catch((error) =>
        this.service.finishActivity(
          activity,
          "failed",
          `Apply failed for plan ${planId}.`,
          { planId, error: message(error) },
        ),
      )
      .finally(() => {
        this.operation = null;
      });
    return json(
      { activityId: activity, status: "running", planId },
      202,
      headers,
    );
  }

  private updateProgress(text: string): void {
    if (!this.operation) return;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const latest = lines.at(-1);
    if (latest) this.operation.message = String(redactSensitive(latest));
  }
}

export function createTidalArtworkResolver(
  fetcher: Fetcher = fetch,
): (albumId: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (albumId) => {
    const existing = cache.get(albumId);
    if (existing) return existing;
    const pending = resolveTidalArtwork(albumId, fetcher);
    cache.set(albumId, pending);
    return pending;
  };
}

async function resolveTidalArtwork(
  albumId: string,
  fetcher: Fetcher,
): Promise<string | null> {
  try {
    const response = await fetcher(
      `https://tidal.com/browse/album/${albumId}`,
      {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return null;
    let artworkUrl: string | null = null;
    const parsed = new HTMLRewriter()
      .on('meta[property="og:image"]', {
        element(element) {
          artworkUrl = element.getAttribute("content");
        },
      })
      .transform(response);
    await parsed.text();
    if (!artworkUrl) return null;
    const url = new URL(artworkUrl);
    return url.protocol === "https:" && url.hostname === "resources.tidal.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function startReviewServer(): void {
  const args = process.argv.slice(2);
  const host = option(args, "--host") ?? "127.0.0.1";
  const port = Number(
    option(args, "--port") ?? process.env.BCTS_REVIEW_PORT ?? 4173,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Review server port is invalid.");
  const requestedConfig = option(args, "--config");
  const config = loadConfig(requestedConfig);
  const databasePath =
    option(args, "--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
  const reviews = new ReviewService(database);
  const service = new M7Service(database, databasePath, config);
  const runtime = new DashboardRuntime(service, requestedConfig);
  const session = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const allowedHosts =
    host === "0.0.0.0" || host === "::"
      ? ["127.0.0.1", "localhost", "[::1]", ...localInterfaceHosts()]
      : [host, "127.0.0.1", "localhost", "[::1]"];
  Bun.serve({
    hostname: host,
    port,
    fetch: createReviewHandler(
      reviews,
      session,
      csrf,
      undefined,
      allowedHosts,
      runtime,
    ),
  });
  setInterval(() => {
    const schedule = service.schedule();
    if (
      schedule.enabled &&
      schedule.nextRunAt &&
      Date.parse(schedule.nextRunAt) <= Date.now() &&
      !runtime.runner.active
    ) {
      service.markScheduledRun();
      runtime.startScan(undefined, true);
    }
  }, 30_000).unref();
  console.log(`Dashboard: http://${host}:${port}`);
  console.log(`Database: ${databasePath}`);
  console.log(
    "Provider writes: require an explicit immutable plan confirmation",
  );
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
    console.warn(`LAN exposure explicitly enabled on ${host}.`);
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 16_384)
    throw new Error("Request body too large");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(-4000);
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "plan";
}

function authorizedMutation(
  request: Request,
  session: string,
  csrf: string,
): boolean {
  const cookies = new Map(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((cookie) => cookie.trim().split("=", 2) as [string, string]),
  );
  return (
    cookies.get("bcts_session") === session &&
    request.headers.get("x-csrf-token") === csrf
  );
}

function json(value: unknown, status: number, headers: Headers): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(value, { status, headers });
}

function securityHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  return value == null || value === "" ? undefined : Number(value);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function canonicalHost(value: string): string {
  const trimmed = value.trim();
  try {
    const isBareIpv6 = isIP(trimmed) === 6;
    const parsed = new URL(`http://${isBareIpv6 ? `[${trimmed}]` : trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/")
      return "";
    return parsed.hostname;
  } catch {
    return "";
  }
}

function localInterfaceHosts(): string[] {
  const hosts: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4") hosts.push(address.address);
      else if (address.family === "IPv6")
        hosts.push(`[${address.address.split("%")[0]}]`);
    }
  }
  return hosts;
}
