import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
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
  const databasePath =
    option(args, "--database") ??
    process.env.BCTS_DATABASE ??
    loadConfig().storage.database;
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
  const reviews = new ReviewService(database);
  const session = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const allowedHosts =
    host === "0.0.0.0" || host === "::"
      ? ["127.0.0.1", "localhost", "[::1]", ...localInterfaceHosts()]
      : [host, "127.0.0.1", "localhost", "[::1]"];
  Bun.serve({
    hostname: host,
    port,
    fetch: createReviewHandler(reviews, session, csrf, undefined, allowedHosts),
  });
  console.log(`Review UI: http://${host}:${port}`);
  console.log(`Database: ${databasePath}`);
  console.log("Provider writes: disabled");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
    console.warn(`LAN exposure explicitly enabled on ${host}.`);
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
