import { describe, expect, test } from "bun:test";
import {
  browserCommand,
  prepareTokenDocument,
  summarizeToken,
} from "../src/oauth";

describe("TIDAL OAuth helpers", () => {
  test("adds a stable expiration timestamp to a token response", () => {
    const token = prepareTokenDocument(
      { access_token: "secret", expires_in: 3600 },
      Date.parse("2026-09-14T00:00:00.000Z"),
    );
    expect(token.expires_at).toBe("2026-09-14T01:00:00.000Z");
  });

  test("reports expiry and missing scopes without returning the token", () => {
    const status = summarizeToken(
      {
        access_token: "must-not-be-returned",
        scope: "collection.read",
        expires_at: "2026-09-14T01:00:00.000Z",
      },
      Date.parse("2026-09-14T02:00:00.000Z"),
    );
    expect(status.expired).toBe(true);
    expect(status.missing_scopes).toEqual(["collection.write"]);
    expect(JSON.stringify(status)).not.toContain("must-not-be-returned");
  });

  test("provides platform browser commands and rejects malformed tokens", () => {
    expect(browserCommand("https://example.test", "darwin")).toEqual({
      command: "open",
      args: ["https://example.test"],
    });
    expect(browserCommand("https://example.test", "unknown")).toBeNull();
    expect(() => prepareTokenDocument({ expires_in: 1 })).toThrow(
      /access_token/,
    );
  });
});
