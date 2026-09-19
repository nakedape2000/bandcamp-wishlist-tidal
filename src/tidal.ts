import { join } from "node:path";
import type { AppConfig } from "./config";
import { request, requestJson } from "./http";
import { readTokenFile, type TokenData } from "./secrets";

export const TIDAL_API_BASE = "https://openapi.tidal.com/v2";

export interface TidalClientOptions {
  tokenPath?: string;
  countryCode?: string;
  locale?: string;
}

export function tidalClientOptionsFromConfig(
  config: AppConfig,
  environment: Record<string, string | undefined> = process.env,
): TidalClientOptions {
  return {
    tokenPath:
      environment.TIDAL_TOKEN_PATH ??
      join(config.storage.output_dir, "tidal-tokens.json"),
    countryCode: config.providers.tidal.country_code,
    locale: config.providers.tidal.locale,
  };
}

export class TidalClient {
  private readonly tokenPath: string;
  private readonly countryCode: string;
  private readonly locale: string;
  private token: TokenData | null = null;

  constructor(options: TidalClientOptions = {}) {
    this.tokenPath = options.tokenPath ?? "./output/tidal-tokens.json";
    this.countryCode = options.countryCode ?? "DE";
    this.locale = options.locale ?? "en-US";
  }

  private async accessToken(): Promise<string> {
    this.token ??= await readTokenFile(this.tokenPath);
    return this.token.access_token;
  }

  async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${TIDAL_API_BASE}${pathOrUrl}`;
    const urlWithDefaults = new URL(url);
    if (!urlWithDefaults.searchParams.has("countryCode"))
      urlWithDefaults.searchParams.set("countryCode", this.countryCode);
    if (!urlWithDefaults.searchParams.has("locale"))
      urlWithDefaults.searchParams.set("locale", this.locale);
    return requestJson<T>(
      urlWithDefaults.toString(),
      {
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          Accept: "application/vnd.api+json",
        },
      },
      { retries: 5, baseDelayMs: 3000, timeoutMs: 20_000 },
    );
  }

  async post<T>(
    pathOrUrl: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ status: number; body: T; headers: Headers }> {
    if (!idempotencyKey)
      throw new Error("Idempotency-Key is required for TIDAL writes");
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${TIDAL_API_BASE}${pathOrUrl}`;
    const response = await request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      { retries: 5, baseDelayMs: 3000, timeoutMs: 30_000 },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status} for ${url}: ${text.slice(0, 1000)}`,
      );
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as T) : (null as T),
      headers: response.headers,
    };
  }
}

export function absoluteTidalUrl(link: string): string {
  return link.startsWith("http://") || link.startsWith("https://")
    ? link
    : `${TIDAL_API_BASE}${link.startsWith("/") ? link : `/${link}`}`;
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

interface TidalReader {
  get<T>(pathOrUrl: string): Promise<T>;
}

export interface TidalLibraryVerification {
  ids: Set<string>;
  missing: string[];
  attempts: number;
}

interface TidalRelationshipDocument {
  data?: Array<{ id?: string; type?: string }>;
  links?: { next?: string | null };
}

export async function fetchTidalLibraryIds(
  client: TidalReader,
): Promise<Set<string>> {
  const initial = await client.get<{
    data?: { relationships?: { items?: TidalRelationshipDocument } };
  }>("/userCollectionAlbums/me?include=items");
  const relationship = initial.data?.relationships?.items;
  const ids = new Set<string>();
  for (const item of asArray(relationship?.data)) {
    if (item.type === "albums" && item.id) ids.add(item.id);
  }
  let next = relationship?.links?.next
    ? absoluteTidalUrl(relationship.links.next)
    : null;
  while (next) {
    const page = await client.get<TidalRelationshipDocument>(next);
    for (const item of asArray(page.data)) {
      if (item.type === "albums" && item.id) ids.add(item.id);
    }
    next = page.links?.next ? absoluteTidalUrl(page.links.next) : null;
  }
  return ids;
}

export async function verifyTidalLibraryIds(
  client: TidalReader,
  requiredIds: Iterable<string>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (missing: string[], nextAttempt: number) => void;
  } = {},
): Promise<TidalLibraryVerification> {
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error("Verification attempts must be a positive integer");
  const required = [...new Set([...requiredIds].map(String))];
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  let ids = new Set<string>();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ids = await fetchTidalLibraryIds(client);
    const missing = required.filter((id) => !ids.has(id));
    if (!missing.length || attempt === attempts)
      return { ids, missing, attempts: attempt };
    options.onRetry?.(missing, attempt + 1);
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  return { ids, missing: required, attempts };
}
