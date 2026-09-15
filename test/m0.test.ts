import { afterEach, expect, test } from "bun:test";
import {
  createBatches,
  idempotencyKeyForBatch,
  successfulIds,
} from "../src/batches";
import { defaultConfig, fromEnvironment, validateConfig } from "../src/config";
import { HttpError, requestJson } from "../src/http";
import { buildImportState } from "../src/import-state";
import { redact } from "../src/logger";
import { fetchTidalLibraryIds, TidalClient } from "../src/tidal";
import { classifyWriteOutcome, shouldRefreshToken } from "../src/write-policy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("default config is safe and versioned", () => {
  const config = defaultConfig();
  expect(config.version).toBe(1);
  expect(config.security.dry_run_by_default).toBe(true);
  expect(config.sync.require_confirmation).toBe(true);
  expect(config.sync.max_additions_per_run).toBeGreaterThan(0);
});

test("config validation rejects missing version", () => {
  expect(() => validateConfig({})).toThrow(/version/i);
});

test("config validation rejects incomplete safety settings", () => {
  expect(() => validateConfig({ version: 1 })).toThrow(/storage/i);
  expect(() =>
    validateConfig({
      ...defaultConfig(),
      security: { dry_run_by_default: false },
    }),
  ).toThrow(/dry_run/i);
});

test("environment overrides runtime sync settings", () => {
  const original = process.env.TIDAL_BATCH_SIZE;
  process.env.TIDAL_BATCH_SIZE = "7";
  expect(fromEnvironment(defaultConfig()).sync.batch_size).toBe(7);
  if (original === undefined) delete process.env.TIDAL_BATCH_SIZE;
  else process.env.TIDAL_BATCH_SIZE = original;
});

test("requestJson retries transient failures", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) return new Response("busy", { status: 503 });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;

  await expect(
    requestJson<{ ok: boolean }>(
      "https://example.test",
      {},
      { baseDelayMs: 0 },
    ),
  ).resolves.toEqual({ ok: true });
  expect(calls).toBe(3);
});

test("requestJson exposes non-retryable HTTP errors", async () => {
  globalThis.fetch = (async () =>
    new Response("nope", { status: 400 })) as unknown as typeof fetch;
  await expect(requestJson("https://example.test")).rejects.toBeInstanceOf(
    HttpError,
  );
});

test("TIDAL client requires an idempotency key for writes", async () => {
  const client = new TidalClient({ tokenPath: "/missing-token.json" });
  await expect(client.post("/albums", {}, "")).rejects.toThrow(/idempotency/i);
});

test("batch helpers support safe resume", () => {
  expect(createBatches([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  expect(() => createBatches([1], 0)).toThrow(/positive/i);
  expect([
    ...successfulIds([
      { ok: true, album_ids: ["1", "2"] },
      { ok: false, album_ids: ["3"] },
    ]),
  ]).toEqual(["1", "2"]);
  expect(idempotencyKeyForBatch("manifest", ["1", "2"])).toBe(
    idempotencyKeyForBatch("manifest", ["1", "2"]),
  );
  expect(idempotencyKeyForBatch("manifest", ["1", "2"])).not.toBe(
    idempotencyKeyForBatch("manifest", ["2", "1"]),
  );
});

test("logger redacts credential-shaped fields recursively", () => {
  expect(
    redact({
      access_token: "secret",
      nested: { Authorization: "Bearer secret" },
      safe: "ok",
    }),
  ).toEqual({
    access_token: "[REDACTED]",
    nested: { Authorization: "[REDACTED]" },
    safe: "ok",
  });
});

test("import state records artifact counts without copying payloads", () => {
  const state = buildImportState({
    "wishlist.json": { items: [1, 2] },
    "tidal-matches.json": [1],
  });
  expect(state.schema_version).toBe(1);
  expect(state.source_files["wishlist.json"]?.record_count).toBe(2);
  expect(state.source_files["tidal-matches.json"]?.record_count).toBe(1);
});

test("write policy stops on unknown outcomes and refreshes once", () => {
  expect(classifyWriteOutcome(204)).toBe("success");
  expect(classifyWriteOutcome(422)).toBe("permanent_failure");
  expect(classifyWriteOutcome(503)).toBe("unknown");
  expect(classifyWriteOutcome(null)).toBe("unknown");
  expect(shouldRefreshToken(401, false)).toBe(true);
  expect(shouldRefreshToken(401, true)).toBe(false);
  expect(shouldRefreshToken(200, false)).toBe(false);
});

test("live library recheck follows pagination and deduplicates ids", async () => {
  const pages = [
    {
      data: {
        relationships: {
          items: {
            data: [{ id: "a", type: "albums" }],
            links: { next: "/page-2" },
          },
        },
      },
    },
    {
      data: [
        { id: "a", type: "albums" },
        { id: "b", type: "albums" },
      ],
    },
  ];
  const reader = {
    get: async <T>() => pages.shift() as T,
  };
  expect([...(await fetchTidalLibraryIds(reader))]).toEqual(["a", "b"]);
});
