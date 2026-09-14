export type ItemType = "album" | "track";

export interface WishlistItem {
  itemId: number;
  itemType: ItemType;
  artist: string;
  title: string;
  url: string;
  artUrl: string | null;
  addedAt: string | null; // ISO 8601
}

export interface WishlistSnapshot {
  schema_version: 1;
  source: "bandcamp";
  username: string;
  fanId: number;
  fetchedAt: string; // ISO 8601
  count: number;
  items: WishlistItem[];
}

export interface RawApiItem {
  item_id: number;
  item_type: string;
  band_name: string;
  item_title: string;
  item_url: string;
  item_art_url?: string | null;
  added?: string | null;
}
