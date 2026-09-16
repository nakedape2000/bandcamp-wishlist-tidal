import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  loadConfig,
  setConfigValue,
  validateConfig,
  writeConfig,
} from "../src/config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("M5 configuration contracts", () => {
  test("writes restrictive, versioned config and preserves defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcts-m5-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeConfig(defaultConfig(), path);
    expect(existsSync(path)).toBe(true);
    expect(
      (Bun.JSONC.parse(readFileSync(path, "utf8")) as { version: number })
        .version,
    ).toBe(1);
    expect(readFileSync(path, "utf8")).toContain("Keep provider tokens");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(defaultConfig().matching.cache_ttl_days).toBe(30);
    expect(defaultConfig().security.bind_host).toBe("127.0.0.1");
  });

  test("sets typed values and validates safety invariants", () => {
    const config = setConfigValue(defaultConfig(), "sync.batch_size", "10");
    expect(config.sync.batch_size).toBe(10);
    expect(() =>
      setConfigValue(config, "security.dry_run_by_default", "false"),
    ).toThrow();
    expect(() => validateConfig({ version: 1 })).toThrow();
    expect(() =>
      setConfigValue(config, "providers.tidal.country_code", "Germany"),
    ).toThrow(/TIDAL/i);
  });

  test("loads older version-one JSON configs with new safe defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcts-m5-legacy-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    delete legacy.matching;
    legacy.security = { dry_run_by_default: true };
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    const loaded = loadConfig(path);
    expect(loaded.matching.cache_ttl_days).toBe(30);
    expect(loaded.security.bind_host).toBe("127.0.0.1");
  });

  test("CLI init supports headless flags and clean JSON output", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcts-m5-cli-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    const result = runCli([
      "--json",
      "--no-color",
      "init",
      "--config",
      path,
      "--country",
      "US",
      "--locale",
      "en-US",
      "--bandcamp-user",
      "fixture-user",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\u001b[");
    const payload = JSON.parse(result.stdout);
    expect(payload.config.providers.tidal.country_code).toBe("US");
    expect(payload.config.providers.bandcamp.username).toBe("fixture-user");
    expect(payload.config.security.dry_run_by_default).toBe(true);
    const auth = runCli(["auth", "status", "--config", path, "--json"], {
      TIDAL_TOKEN_PATH: "",
    });
    expect(JSON.parse(auth.stdout).token_path).toBe(
      join(dir, "output", "tidal-tokens.json"),
    );
  });

  test("auth status never exposes token contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcts-m5-auth-"));
    dirs.push(dir);
    const tokenPath = join(dir, "tokens.json");
    await Bun.write(
      tokenPath,
      JSON.stringify({
        access_token: "private-token-value",
        scope: "collection.read collection.write",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
    );
    const result = runCli(["auth", "status", "--json"], {
      TIDAL_TOKEN_PATH: tokenPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("private-token-value");
    expect(JSON.parse(result.stdout).missing_scopes).toEqual([]);
  });

  test("plan create/show and apply dry-run form one JSON-safe workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcts-m5-plan-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    expect(runCli(["init", "--config", config, "--quiet"]).exitCode).toBe(0);
    const created = runCli(["plan", "create", "--config", config, "--json"]);
    expect(created.exitCode).toBe(0);
    const planId = JSON.parse(created.stdout).plan_id as string;
    const shown = runCli([
      "plan",
      "show",
      planId,
      "--config",
      config,
      "--json",
    ]);
    expect(JSON.parse(shown.stdout).plan_id).toBe(planId);
    const dryRun = runCli(["apply", planId, "--config", config, "--json"]);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      plan_id: planId,
      mode: "dry-run",
      provider_writes: 0,
    });
  });

  test("help exposes the canonical M5 command surface", () => {
    const result = runCli(["--help", "--json"]);
    expect(result.exitCode).toBe(0);
    const commands = JSON.parse(result.stdout).commands as string[];
    for (const command of [
      "auth tidal",
      "import bandcamp",
      "scan",
      "matches list",
      "plan create",
      "plan show",
      "verify",
      "logs",
      "self-update",
    ])
      expect(commands).toContain(command);
  });

  test("offline tutorial works outside the source checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcts-m5-tutorial-"));
    dirs.push(dir);
    const result = runCli(["tutorial"], {}, dir);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    expect(payload).toMatchObject({
      fan_id: 424242,
      mode: "fixture-dry-run",
      item_count: 2,
      provider_writes: 0,
    });
  });
});

function runCli(
  args: string[],
  environment: Record<string, string> = {},
  cwd = process.cwd(),
) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "..", "scripts/main.ts"),
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
