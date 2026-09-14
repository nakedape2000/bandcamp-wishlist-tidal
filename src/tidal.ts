import { request, requestJson } from "./http";
import { readTokenFile, type TokenData } from "./secrets";

export const TIDAL_API_BASE = "https://openapi.tidal.com/v2";

export interface TidalClientOptions {
  tokenPath?: string;
  countryCode?: string;
  locale?: string;
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

interface TidalRelationshipDocument {
  data?: Array<{ id?: string; type?: string }>;
  links?: { next?: string | null };
}

export async function fetchTidalLibraryIds(
  client: TidalReader,
): Promise<Set<string>> {
  const initial = await client.get<{
    data?: { relationships?: { items?: TidalRelationshipDocument } };
  }>("/userCollectionAlbums/me");
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
