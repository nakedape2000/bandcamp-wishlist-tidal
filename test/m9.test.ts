import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, writeConfig } from "../src/config";
import { diagnoseLaunch } from "../src/launcher";
import {
  applicationDataDirectory,
  defaultApplicationPaths,
  preferredConfigPath,
} from "../src/platform";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("M9 installation and launch foundation", () => {
  test("uses predictable platform data directories with an explicit override", () => {
    expect(applicationDataDirectory({}, "darwin", "/Users/fixture")).toBe(
      join(
        "/Users/fixture",
        "Library",
        "Application Support",
        "bandcamp-tidal-sync",
      ),
    );
    expect(applicationDataDirectory({}, "win32", "C:\\Users\\fixture")).toBe(
      join("C:\\Users\\fixture", "AppData", "Roaming", "bandcamp-tidal-sync"),
    );
    expect(applicationDataDirectory({}, "linux", "/home/fixture")).toBe(
      join("/home/fixture", ".local", "state", "bandcamp-tidal-sync"),
    );
    const portable = join(tmpdir(), "bcts-portable-data");
    expect(applicationDataDirectory({ BCTS_DATA_DIR: portable }, "linux")).toBe(
      resolve(portable),
    );
    expect(defaultApplicationPaths({}, "linux", "/home/fixture")).toEqual({
      dataDirectory: join(
        "/home/fixture",
        ".local",
        "state",
        "bandcamp-tidal-sync",
      ),
      configPath: join(
        "/home/fixture",
        ".local",
        "state",
        "bandcamp-tidal-sync",
        "config.json",
      ),
      databasePath: join(
        "/home/fixture",
        ".local",
        "state",
        "bandcamp-tidal-sync",
        "data.sqlite",
      ),
      outputDirectory: join(
        "/home/fixture",
        ".local",
        "state",
        "bandcamp-tidal-sync",
        "output",
      ),
    });
  });

  test("keeps a legacy project config instead of moving user data", () => {
    const directory = mkdtempSync(join(tmpdir(), "bcts-m9-legacy-"));
    directories.push(directory);
    const legacy = join(directory, "config.json");
    writeFileSync(legacy, "{}", "utf8");
    expect(preferredConfigPath({}, directory)).toBe(legacy);
    expect(
      preferredConfigPath({ BCTS_CONFIG: "/chosen/config.json" }, directory),
    ).toBe("/chosen/config.json");
  });

  test("launch diagnostics report a usable local installation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bcts-m9-ready-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    writeConfig(
      {
        ...defaultConfig(),
        storage: {
          database: join(directory, "data.sqlite"),
          output_dir: join(directory, "output"),
        },
      },
      configPath,
    );
    const diagnostics = await diagnoseLaunch(
      { configPath, port: 4173 },
      { canBind: async () => true, dockerAvailable: () => true },
    );
    expect(diagnostics.ready).toBe(true);
    expect(diagnostics.address).toBe("http://127.0.0.1:4173");
    expect(diagnostics.checks.every((check) => check.ok)).toBe(true);
  });

  test("launch diagnostics make config, data, port, and Docker failures actionable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bcts-m9-invalid-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, '{"version":999}', "utf8");
    const diagnostics = await diagnoseLaunch(
      { configPath, port: 4173, docker: true },
      {
        runtime: () => ({ available: false, detail: "Bun is not installed" }),
        canBind: async () => false,
        canWrite: async () => {
          throw new Error("permission denied");
        },
        dockerAvailable: () => false,
      },
    );
    expect(diagnostics.ready).toBe(false);
    expect(diagnostics.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Configuration or data directory",
          ok: false,
        }),
        expect.objectContaining({ name: "Bun runtime", ok: false }),
        expect.objectContaining({ name: "Dashboard port", ok: false }),
        expect.objectContaining({ name: "Docker Compose", ok: false }),
      ]),
    );
    expect(
      diagnostics.checks.map((check) => check.detail).join("\n"),
    ).toContain(`Fix ${configPath}`);
  });
});
