import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  classifyNoCandidates,
  normalizeMatchText,
  scoreMatch,
  detectDuplicateEditions,
} from "../src/matching";
import { MatchCache } from "../src/match-cache";
import { createAdditionPlan } from "../src/addition-plan";
const fixtures = JSON.parse(
  readFileSync("test/fixtures/m2-matching.json", "utf8"),
) as Array<{
  input: { artist: string; title: string };
  candidate: { id: string; artist: string; title: string };
  aliases?: Record<string, string[]>;
  expected: import("../src/matching").MatchStatus;
}>;

describe("matching", () => {
  test("normalizes unicode, punctuation, and edition markers", () => {
    expect(normalizeMatchText("Beyoncé - Live (Deluxe Edition)")).toBe(
      "beyonce live",
    );
  });
  test("returns an explainable high-confidence match", () => {
    const result = scoreMatch(
      { artist: "Beyonce", title: "Renaissance" },
      { id: "1", artist: "Beyoncé", title: "Renaissance" },
    );
    expect(result.status).toBe("high_confidence");
    expect(result.explanation).toContain("title 100%");
  });
  test("uses aliases and configurable thresholds", () => {
    const result = scoreMatch(
      { artist: "The Weeknd", title: "Dawn FM" },
      { id: "1", artist: "Weeknd", title: "Dawn FM" },
      { "the weeknd": ["Weeknd"] },
      { high: 85, review: 50 },
    );
    expect(result.explanation).toContain("artist alias matched");
    expect(result.status).toBe("high_confidence");
  });
  test("explains not found candidates", () => {
    expect(classifyNoCandidates().explanation).toContain("no TIDAL candidates");
  });
  test("deduplicates unchanged catalogue lookups through a TTL cache", () => {
    const database = new Database(":memory:");
    const cache = new MatchCache(database);
    cache.set("query:beyonce", ["1"], "2026-01-01T00:00:00.000Z");
    expect(
      cache.get<string[]>(
        "query:beyonce",
        86_400_000,
        Date.parse("2026-01-02T00:00:00.000Z"),
      )?.value,
    ).toEqual(["1"]);
    expect(
      cache.get<string[]>(
        "query:beyonce",
        86_400_000,
        Date.parse("2026-01-03T00:00:00.000Z"),
      ),
    ).toBeNull();
    database.close();
  });
  test("keeps minimized regression fixtures stable", () => {
    for (const fixture of fixtures) {
      const result = scoreMatch(
        fixture.input,
        fixture.candidate,
        fixture.aliases,
      );
      expect(result.status).toBe(fixture.expected);
      expect(result.explanation).toContain(":");
    }
  });
  test("flags duplicate editions for review", () => {
    const groups = detectDuplicateEditions([
      { id: "a", artist: "Beyoncé", title: "Renaissance (Deluxe Edition)" },
      { id: "b", artist: "Beyonce", title: "Renaissance" },
    ]);
    expect(groups[0]?.candidateIds).toEqual(["a", "b"]);
  });
  test("builds a fresh staged plan and excludes saved or duplicate albums", () => {
    const plan = createAdditionPlan(
      [
        { tidal_album_id: "saved" },
        { tidal_album_id: "a" },
        { tidal_album_id: "a" },
        { tidal_album_id: "b" },
        { tidal_album_id: "c" },
      ],
      ["saved"],
      2,
    );
    expect(plan.pilot.map((item) => item.tidal_album_id)).toEqual(["a", "b"]);
    expect(plan.remaining.map((item) => item.tidal_album_id)).toEqual(["c"]);
    expect(plan.skippedAlreadySaved).toEqual(["saved"]);
  });
});
