/**
 * Stable boundary between provider-neutral application code and a music
 * service's HTTP/OAuth implementation. Provider adapters must not expose raw
 * HTTP documents outside this module boundary.
 */
export type ProviderId = string;

/** Increment only for a breaking change to an adapter method or normalized value. */
export const PROVIDER_CONTRACT_VERSION = 1;

export function providerConfigNamespace(providerId: ProviderId): string {
  if (!/^[a-z][a-z0-9-]*$/.test(providerId))
    throw new Error(`Invalid provider id "${providerId}".`);
  return `providers.${providerId}`;
}

export const sourceCapabilities = ["wishlist-read"] as const;
export type SourceCapability = (typeof sourceCapabilities)[number];

export const destinationCapabilities = [
  "catalogue-search",
  "collection-read",
  "collection-write",
  "authorization-status",
] as const;

export type DestinationCapability = (typeof destinationCapabilities)[number];

export interface ProviderAlbum {
  id: string;
  title: string;
  artists: string[];
  url: string;
  artworkUrl?: string;
  releaseDate?: string;
  trackCount?: number;
}

export interface ProviderAuthorizationStatus {
  configured: boolean;
  expired: boolean | null;
  missingScopes: string[];
  detail: string;
}

export interface ProviderWriteResult {
  status: number;
  responseBody: unknown;
}

export interface CollectionVerification {
  ids: Set<string>;
  missing: string[];
  attempts: number;
}

export interface DestinationProvider {
  readonly id: ProviderId;
  readonly contractVersion: typeof PROVIDER_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<DestinationCapability>;
  authorizationStatus(): Promise<ProviderAuthorizationStatus>;
  searchAlbums(query: string): Promise<ProviderAlbum[]>;
  readCollectionAlbumIds(collection: string): Promise<Set<string>>;
  addAlbums(
    collection: string,
    albumIds: readonly string[],
    idempotencyKey: string,
  ): Promise<ProviderWriteResult>;
  verifyCollectionAlbumIds(
    collection: string,
    requiredIds: Iterable<string>,
    options?: VerificationOptions,
  ): Promise<CollectionVerification>;
}

export interface SourceWishlistSnapshot {
  providerId: ProviderId;
  username: string;
  fanId: number;
  fetchedAt: string;
  items: Array<{
    itemId: number;
    itemType: "album" | "track";
    artist: string;
    title: string;
    url: string;
    artUrl: string | null;
    addedAt: string | null;
  }>;
}

export interface WishlistSourceProvider {
  readonly id: ProviderId;
  readonly contractVersion: typeof PROVIDER_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<SourceCapability>;
  fetchWishlist(
    username: string,
    options?: { onProgress?: (loaded: number) => void },
  ): Promise<SourceWishlistSnapshot>;
}

export interface VerificationOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (missing: string[], nextAttempt: number) => void;
}

export class ProviderCapabilityError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly capability: DestinationCapability,
  ) {
    super(
      `Provider "${providerId}" does not support ${capability}. No provider request was made.`,
    );
    this.name = "ProviderCapabilityError";
  }
}

export function requireCapability(
  provider: Pick<DestinationProvider, "id" | "capabilities">,
  capability: DestinationCapability,
): void {
  if (!provider.capabilities.has(capability))
    throw new ProviderCapabilityError(provider.id, capability);
}
