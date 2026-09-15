import type { Database } from "bun:sqlite";

export interface CacheEntry<T> {
  value: T;
  fetchedAt: string;
}

export class MatchCache {
  constructor(private readonly database: Database) {
    database.exec(
      "CREATE TABLE IF NOT EXISTS match_cache (cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL)",
    );
  }
  get<T>(key: string, ttlMs: number, now = Date.now()): CacheEntry<T> | null {
    const row = this.database
      .query("SELECT value, fetched_at FROM match_cache WHERE cache_key = ?")
      .get(key) as { value: string; fetched_at: string } | null;
    if (!row || now - Date.parse(row.fetched_at) > ttlMs) return null;
    return { value: JSON.parse(row.value) as T, fetchedAt: row.fetched_at };
  }
  set<T>(key: string, value: T, fetchedAt = new Date().toISOString()): void {
    this.database
      .query(
        "INSERT OR REPLACE INTO match_cache (cache_key, value, fetched_at) VALUES (?, ?, ?)",
      )
      .run(key, JSON.stringify(value), fetchedAt);
  }
  clear(): number {
    return this.database.query("DELETE FROM match_cache").run().changes;
  }
}
