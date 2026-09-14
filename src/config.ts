import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AppConfig {
  version: 1;
  storage: { database: string; output_dir: string };
  providers: {
    bandcamp: { wishlist_source: "browser-export"; username: string };
    tidal: { country_code: string; locale: string; collection: "me" };
  };
  matching: {
    high_confidence_threshold: number;
    review_threshold: number;
    cache_ttl_days: number;
  };
  sync: {
    batch_size: number;
    max_additions_per_run: number;
    delay_between_batches_ms: number;
    require_confirmation: boolean;
    verify_after_apply: boolean;
  };
  security: { bind_host: string; dry_run_by_default: boolean };
}

export function defaultConfig(): AppConfig {
  const root = join(homedir(), ".config", "bandcamp-tidal-sync");
  return {
    version: 1,
    storage: {
      database: join(root, "data.sqlite"),
      output_dir: join(root, "output"),
    },
    providers: {
      bandcamp: { wishlist_source: "browser-export", username: "" },
      tidal: { country_code: "DE", locale: "en-US", collection: "me" },
    },
    matching: {
      high_confidence_threshold: 0.9,
      review_threshold: 0.7,
      cache_ttl_days: 30,
    },
    sync: {
      batch_size: 25,
      max_additions_per_run: 250,
      delay_between_batches_ms: 2000,
      require_confirmation: true,
      verify_after_apply: true,
    },
    security: { bind_host: "127.0.0.1", dry_run_by_default: true },
  };
}

export function validateConfig(value: unknown): AppConfig {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error("Configuration must be an object with version: 1");
  }
  const config = value as Partial<AppConfig>;
  if (!config.storage?.database || !config.storage.output_dir)
    throw new Error(
      "Configuration storage.database and storage.output_dir are required",
    );
  if (
    !/^[A-Z]{2}$/.test(config.providers?.tidal?.country_code ?? "") ||
    !/^[a-z]{2}-[A-Z]{2}$/.test(config.providers?.tidal?.locale ?? "") ||
    config.providers?.tidal?.collection !== "me"
  )
    throw new Error("Configuration TIDAL settings are invalid");
  if (
    config.providers?.bandcamp?.wishlist_source !== "browser-export" ||
    typeof config.providers.bandcamp.username !== "string"
  )
    throw new Error("Configuration Bandcamp settings are invalid");
  if (
    !config.sync ||
    !Number.isInteger(config.sync.batch_size) ||
    config.sync.batch_size <= 0 ||
    !Number.isInteger(config.sync.max_additions_per_run) ||
    config.sync.max_additions_per_run <= 0 ||
    !Number.isInteger(config.sync.delay_between_batches_ms) ||
    config.sync.delay_between_batches_ms < 0
  )
    throw new Error("Configuration sync settings are invalid");
  if (
    !config.matching ||
    typeof config.matching.high_confidence_threshold !== "number" ||
    typeof config.matching.review_threshold !== "number" ||
    config.matching.high_confidence_threshold <
      config.matching.review_threshold ||
    config.matching.review_threshold < 0 ||
    config.matching.high_confidence_threshold > 1 ||
    !Number.isInteger(config.matching.cache_ttl_days) ||
    config.matching.cache_ttl_days <= 0
  )
    throw new Error("Configuration matching settings are invalid");
  if (config.security?.dry_run_by_default !== true)
    throw new Error("Configuration must keep dry_run_by_default enabled");
  if (!config.security.bind_host)
    throw new Error("Configuration security.bind_host is required");
  return config as AppConfig;
}

export function loadConfig(
  path = process.env.BCTS_CONFIG ?? "./config.json",
): AppConfig {
  if (!existsSync(path)) return fromEnvironment(defaultConfig());
  const raw = Bun.JSONC.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  const defaults = defaultConfig();
  return fromEnvironment(
    validateConfig({
      ...defaults,
      ...raw,
      storage: { ...defaults.storage, ...raw.storage },
      providers: {
        ...defaults.providers,
        ...raw.providers,
        tidal: { ...defaults.providers.tidal, ...raw.providers?.tidal },
        bandcamp: {
          ...defaults.providers.bandcamp,
          ...raw.providers?.bandcamp,
        },
      },
      matching: { ...defaults.matching, ...raw.matching },
      sync: { ...defaults.sync, ...raw.sync },
      security: { ...defaults.security, ...raw.security },
    }),
  );
}

export function configPath(
  path = process.env.BCTS_CONFIG ?? "./config.json",
): string {
  return path;
}

export function writeConfig(config: AppConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const comments =
    "// Bandcamp to TIDAL Sync configuration (version 1).\n" +
    "// Keep provider tokens and client secrets out of this file.\n" +
    "// New installations remain dry-run-only until an explicit apply command.\n";
  writeFileSync(
    path,
    `${comments}${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  if (path !== ":memory:") chmodSync(path, 0o600);
}

export function setConfigValue(
  config: AppConfig,
  key: string,
  rawValue: string,
): AppConfig {
  const parts = key.split(".").filter(Boolean);
  if (!parts.length) throw new Error("Configuration key is required.");
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next))
      throw new Error(`Unknown configuration path: ${key}`);
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  if (!(leaf in cursor)) throw new Error(`Unknown configuration key: ${key}`);
  const current = cursor[leaf];
  let value: unknown = rawValue;
  if (typeof current === "number") {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`Invalid number for ${key}`);
  } else if (typeof current === "boolean") {
    if (!/^(true|false)$/i.test(rawValue))
      throw new Error(`Invalid boolean for ${key}`);
    value = rawValue.toLowerCase() === "true";
  }
  cursor[leaf] = value;
  return validateConfig(clone);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function fromEnvironment(config: AppConfig): AppConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      tidal: {
        ...config.providers.tidal,
        country_code:
          process.env.TIDAL_COUNTRY_CODE ?? config.providers.tidal.country_code,
        locale: process.env.TIDAL_LOCALE ?? config.providers.tidal.locale,
      },
    },
    sync: {
      ...config.sync,
      batch_size: positiveInt(
        process.env.TIDAL_BATCH_SIZE,
        config.sync.batch_size,
      ),
      delay_between_batches_ms: positiveInt(
        process.env.TIDAL_DELAY_MS,
        config.sync.delay_between_batches_ms,
      ),
      max_additions_per_run: positiveInt(
        process.env.TIDAL_MAX_ADDITIONS,
        config.sync.max_additions_per_run,
      ),
    },
  };
}
