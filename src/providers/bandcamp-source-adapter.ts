import { fetchAllWishlistItems, resolveFanId } from "../bandcamp";
import {
  PROVIDER_CONTRACT_VERSION,
  type SourceCapability,
  type SourceWishlistSnapshot,
  type WishlistSourceProvider,
} from "../provider-contract";
import type { WishlistItem } from "../types";

export interface BandcampWishlistReader {
  resolveFanId(username: string): Promise<number>;
  fetchAllWishlistItems(
    fanId: number,
    count: number,
    onProgress?: (loaded: number) => void,
  ): Promise<WishlistItem[]>;
}

/** Contains the public-Bandcamp details behind the source-provider boundary. */
export class BandcampSourceAdapter implements WishlistSourceProvider {
  readonly id = "bandcamp";
  readonly contractVersion = PROVIDER_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<SourceCapability> = new Set([
    "wishlist-read",
  ]);

  constructor(
    private readonly reader: BandcampWishlistReader = {
      resolveFanId,
      fetchAllWishlistItems,
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchWishlist(
    username: string,
    options: { onProgress?: (loaded: number) => void } = {},
  ): Promise<SourceWishlistSnapshot> {
    const fanId = await this.reader.resolveFanId(username);
    const items = await this.reader.fetchAllWishlistItems(
      fanId,
      100,
      options.onProgress,
    );
    return {
      providerId: this.id,
      username,
      fanId,
      fetchedAt: this.now().toISOString(),
      items,
    };
  }
}

export function createBandcampSourceAdapter(): BandcampSourceAdapter {
  return new BandcampSourceAdapter();
}
