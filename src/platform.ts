import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ApplicationPaths {
  dataDirectory: string;
  configPath: string;
  databasePath: string;
  outputDirectory: string;
}

/**
 * Returns the one local data directory for a new installation. BCTS_DATA_DIR
 * is deliberately the portable override used by Docker and test environments.
 */
export function applicationDataDirectory(
  environment: Record<string, string | undefined> = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  if (environment.BCTS_DATA_DIR) return resolve(environment.BCTS_DATA_DIR);
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "bandcamp-tidal-sync");
  if (platform === "win32")
    return join(
      environment.APPDATA ??
        environment.LOCALAPPDATA ??
        join(home, "AppData", "Roaming"),
      "bandcamp-tidal-sync",
    );
  return join(
    environment.XDG_STATE_HOME ?? join(home, ".local", "state"),
    "bandcamp-tidal-sync",
  );
}

export function defaultApplicationPaths(
  environment: Record<string, string | undefined> = process.env,
  platform = process.platform,
  home = homedir(),
): ApplicationPaths {
  const dataDirectory = applicationDataDirectory(environment, platform, home);
  return {
    dataDirectory,
    configPath: join(dataDirectory, "config.json"),
    databasePath: join(dataDirectory, "data.sqlite"),
    outputDirectory: join(dataDirectory, "output"),
  };
}

/** Preserve a project-local config created by releases before M9. */
export function preferredConfigPath(
  environment: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  if (environment.BCTS_CONFIG) return environment.BCTS_CONFIG;
  const legacy = join(cwd, "config.json");
  return isLegacyConfig(legacy)
    ? legacy
    : defaultApplicationPaths(environment).configPath;
}

function isLegacyConfig(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const value = Bun.JSONC.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      storage?: unknown;
      providers?: unknown;
    };
    return (
      value?.version === 1 &&
      Boolean(value.storage && typeof value.storage === "object") &&
      Boolean(value.providers && typeof value.providers === "object")
    );
  } catch {
    return false;
  }
}
