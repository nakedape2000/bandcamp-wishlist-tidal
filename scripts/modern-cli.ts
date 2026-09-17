import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  configPath,
  defaultConfig,
  loadConfig,
  setConfigValue,
  validateConfig,
  writeConfig,
} from "../src/config";
import { MatchCache } from "../src/match-cache";
import { summarizeToken } from "../src/oauth";
import { SyncStore } from "../src/sync-store";
import { Terminal } from "../src/terminal";

const args = process.argv.slice(2);
const requestedConfig = option("--config");
const requestedDatabase = option("--database");
if (requestedConfig) process.env.BCTS_CONFIG = requestedConfig;
if (requestedDatabase) process.env.BCTS_DATABASE = requestedDatabase;
const json = args.includes("--json");
const quiet = args.includes("--quiet");
const terminal = new Terminal({
  json,
  quiet,
  verbose: args.includes("--verbose"),
  color:
    !args.includes("--no-color") &&
    !process.env.NO_COLOR &&
    process.stdout.isTTY,
});
const command = args.find((arg) => !arg.startsWith("--")) ?? "help";
const index = args.indexOf(command);
const rest = index >= 0 ? positional(args.slice(index + 1)) : [];
function output(value: unknown, human: string): void {
  terminal.output(value, human);
}
if (["help", "--help"].includes(command))
  output(
    {
      commands: [
        "init",
        "config show",
        "config set",
        "status",
        "doctor",
        "auth tidal",
        "review",
        "import bandcamp",
        "scan",
        "matches list",
        "plan create",
        "plan show",
        "apply",
        "verify",
        "logs",
        "auth status",
        "cache clear",
        "export report",
        "completions",
        "tutorial",
        "self-update",
      ],
    },
    "Usage: bun run sync -- <command> [options]\n\nCommands:\n  init | config show/set | doctor | auth tidal/status\n  import bandcamp | scan | matches list | review\n  plan create/show | apply | verify | status | logs\n  export report | cache clear | completions | tutorial | self-update\n\nGlobal options: --json, --no-color, --quiet, --verbose",
  );
else if (command === "init") {
  const path = option("--config") ?? configPath();
  if (existsSync(path) && !args.includes("--force"))
    throw new Error(`Config already exists: ${path} (use --force to replace)`);
  const base = dirname(path);
  const defaults = defaultConfig();
  const configured = {
    ...defaults,
    storage: {
      database: option("--database") ?? join(base, "data.sqlite"),
      output_dir: option("--output-dir") ?? join(base, "output"),
    },
    providers: {
      ...defaults.providers,
      bandcamp: {
        ...defaults.providers.bandcamp,
        username:
          option("--bandcamp-user") ?? defaults.providers.bandcamp.username,
      },
      tidal: {
        ...defaults.providers.tidal,
        country_code: (
          option("--country") ?? defaults.providers.tidal.country_code
        ).toUpperCase(),
        locale: option("--locale") ?? defaults.providers.tidal.locale,
      },
    },
  };
  const config = args.includes("--interactive")
    ? await promptForConfig(configured)
    : validateConfig(configured);
  writeConfig(config, path);
  mkdirSync(dirname(config.storage.database), { recursive: true });
  mkdirSync(config.storage.output_dir, { recursive: true });
  output(
    { path, config },
    "Created config: " +
      path +
      "\nDatabase: " +
      config.storage.database +
      "\nOutput: " +
      config.storage.output_dir +
      "\nNext: bun run sync -- tutorial",
  );
} else if (command === "config") {
  const subcommand = rest.shift() ?? "show";
  const path = option("--config") ?? configPath();
  if (subcommand === "show") {
    const config = loadConfig(path);
    output(config, JSON.stringify(config, null, 2));
  } else if (subcommand === "set") {
    const key = rest.shift();
    const value = rest.shift();
    if (!key || value === undefined)
      throw new Error("config set requires <key> <value>");
    const next = setConfigValue(loadConfig(path), key, value);
    writeConfig(next, path);
    output({ path, key, config: next }, `Updated ${key} in ${path}`);
  } else throw new Error(`Unknown config command: ${subcommand}`);
} else if (command === "status") {
  const config = loadConfig(option("--config") ?? configPath());
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  if (!existsSync(databasePath))
    output(
      { database: databasePath, initialized: false },
      `Database not initialized: ${databasePath}`,
    );
  else {
    const database = new Database(databasePath, { readonly: true });
    const state = new SyncStore(database).summary();
    database.close();
    output(
      { database: databasePath, initialized: true, ...state },
      "Database: " +
        databasePath +
        "\n" +
        Object.entries(state)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
    );
  }
} else if (command === "auth") {
  const subcommand = rest.shift() ?? "status";
  const authConfig = loadConfig(option("--config") ?? configPath());
  const tokenPath = resolveTokenPath(authConfig);
  process.env.TIDAL_TOKEN_PATH = tokenPath;
  if (subcommand === "tidal") {
    if (!process.env.TIDAL_CLIENT_ID)
      throw new Error(
        "TIDAL OAuth needs TIDAL_CLIENT_ID. Add it to .env, then rerun `sync auth tidal`. Required scopes: collection.read (read library) and collection.write (add approved albums). The callback stays on localhost.",
      );
    console.log(
      "TIDAL OAuth will request collection.read and collection.write. The browser callback is local; no provider writes occur during authorization.",
    );
    await import("../tidal-auth");
  } else if (subcommand !== "status")
    throw new Error(`Unknown auth command: ${subcommand}`);
  else {
    const present = existsSync(tokenPath);
    let status = {
      configured: false,
      expires_at: null as string | null,
      expired: null as boolean | null,
      scopes: [] as string[],
      missing_scopes: ["collection.read", "collection.write"],
    };
    if (present) {
      const raw = JSON.parse(await Bun.file(tokenPath).text()) as Record<
        string,
        unknown
      >;
      status = summarizeToken(raw);
    }
    output(
      { token_path: tokenPath, present, ...status },
      status.configured
        ? `TIDAL token present: ${tokenPath}\nExpired: ${status.expired ?? "unknown"}\nMissing scopes: ${status.missing_scopes.join(", ") || "none"}`
        : `TIDAL token not found: ${tokenPath}`,
    );
  }
} else if (command === "scan") {
  process.env.BCTS_PIPELINE = "1";
  const scanConfig = loadConfig(option("--config") ?? configPath());
  process.env.TIDAL_TOKEN_PATH = resolveTokenPath(scanConfig);
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    scanConfig.storage.database;
  const beforeRefresh = readWishlistState(databasePath);
  await import("./scan-bandcamp");
  await import("../tidal-export-library");
  await import("../tidal-scan");
  await import("./sync");
  const refresh = summarizeRefresh(beforeRefresh, databasePath);
  output(
    {
      mode: args.includes("--full") ? "full" : "incremental",
      database: databasePath,
      refresh,
      state: readState(databasePath),
      provider_writes: 0,
    },
    [
      `Scan complete. Database: ${databasePath}`,
      `Refresh: ${refresh.discovered} new, ${refresh.changed} changed, ${refresh.removed} removed`,
      `New items matched: ${refresh.new_matched}; needs review: ${refresh.new_needs_review}; not found: ${refresh.new_not_found}`,
      "Provider writes: 0",
    ].join("\n"),
  );
} else if (command === "import") {
  const provider = rest.shift();
  if (provider !== "bandcamp")
    throw new Error("import requires provider: bandcamp");
  const source = option("--from") ?? process.env.BCTS_WISHLIST_SNAPSHOT;
  if (source) process.env.BCTS_WISHLIST_SNAPSHOT = source;
  await import("./sync");
} else if (command === "tutorial") {
  terminal.info(
    "Running the offline fixture tutorial. No account or network access is used.",
  );
  await import("./fixture-dry-run");
} else if (command === "self-update") {
  const packageJson = (await Bun.file(
    join(import.meta.dir, "..", "package.json"),
  ).json()) as { version: string };
  output(
    {
      current_version: packageJson.version,
      managed_install: false,
      update_available: null,
    },
    `Current version: ${packageJson.version}. This source checkout is updated with Git; automatic replacement is disabled.`,
  );
} else if (command === "matches") {
  if ((rest.shift() ?? "list") !== "list")
    throw new Error("Unknown matches command");
  const config = loadConfig(option("--config") ?? configPath());
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  if (!existsSync(databasePath))
    output({ database: databasePath, matches: [] }, "No database initialized.");
  else {
    const db = new Database(databasePath, { readonly: true });
    const matches = db
      .query(
        "SELECT bandcamp_item_id, status, best_match_id, decided_at FROM match_decisions ORDER BY bandcamp_item_id",
      )
      .all();
    db.close();
    output(
      { database: databasePath, matches },
      JSON.stringify(matches, null, 2),
    );
  }
} else if (command === "logs") {
  const runId = rest.shift();
  if (runId && (!Number.isInteger(Number(runId)) || Number(runId) <= 0))
    throw new Error("logs run id must be a positive integer");
  const config = loadConfig(option("--config") ?? configPath());
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  if (!existsSync(databasePath))
    output({ database: databasePath, runs: [] }, "No database initialized.");
  else {
    const db = new Database(databasePath, { readonly: true });
    const runs = runId
      ? db.query("SELECT * FROM sync_runs WHERE run_id = ?").all(Number(runId))
      : db.query("SELECT * FROM sync_runs ORDER BY run_id DESC").all();
    db.close();
    output({ database: databasePath, runs }, JSON.stringify(runs, null, 2));
  }
} else if (command === "verify") {
  const planId = rest.shift();
  if (!planId) throw new Error("verify requires <plan-id>");
  const config = loadConfig(option("--config") ?? configPath());
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  if (!existsSync(databasePath))
    output({ plan_id: planId, found: false }, `Plan not found: ${planId}`);
  else {
    const db = new Database(databasePath, { readonly: true });
    const plan = db
      .query(
        "SELECT plan_id, status, created_at, provider, collection FROM write_plans WHERE plan_id = ?",
      )
      .get(planId);
    const attempts = db
      .query(
        "SELECT batch_number, status, response_status FROM write_attempts WHERE plan_id = ? ORDER BY batch_number",
      )
      .all(planId);
    db.close();
    output(
      { plan_id: planId, found: Boolean(plan), plan, attempts },
      JSON.stringify({ plan_id: planId, plan, attempts }, null, 2),
    );
  }
} else if (command === "cache") {
  if ((rest.shift() ?? "clear") !== "clear")
    throw new Error("Unknown cache command");
  const config = loadConfig(option("--config") ?? configPath());
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  if (!existsSync(databasePath))
    output(
      { database: databasePath, cleared: 0 },
      `Database not initialized: ${databasePath}`,
    );
  else {
    const database = new Database(databasePath);
    const cleared = new MatchCache(database).clear();
    database.close();
    output(
      { database: databasePath, cleared },
      `Cleared ${cleared} cached entries.`,
    );
  }
} else if (command === "export") {
  if ((rest.shift() ?? "report") !== "report")
    throw new Error("Unknown export command");
  const config = loadConfig(option("--config") ?? configPath());
  const databasePath =
    option("--database") ??
    process.env.BCTS_DATABASE ??
    config.storage.database;
  const state = existsSync(databasePath) ? readState(databasePath) : null;
  const report = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    database: databasePath,
    state,
  };
  const out =
    option("--out") ??
    rest.shift() ??
    join(config.storage.output_dir, "report.v1.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  chmodSync(out, 0o600);
  output({ out, ...report }, `Exported report: ${out}`);
} else if (command === "completions") {
  const shell = rest.shift() ?? "zsh";
  const commands =
    "init config status doctor auth import scan matches review plan apply verify logs export cache completions tutorial self-update";
  const completion =
    shell === "zsh"
      ? `#compdef sync\n_sync() { _arguments '1:command:(${commands})'; }\ncompdef _sync sync\n`
      : shell === "bash"
        ? `complete -W '${commands}' sync\n`
        : shell === "fish"
          ? `${commands
              .split(" ")
              .map((item) => `complete -c sync -f -a ${item}`)
              .join("\n")}\n`
          : shell === "powershell"
            ? `Register-ArgumentCompleter -CommandName sync -ScriptBlock { param($wordToComplete) '${commands}'.Split(' ') }\n`
            : (() => {
                throw new Error(`Unsupported shell: ${shell}`);
              })();
  output({ shell, completion }, completion);
} else if (command === "doctor") await import("./doctor");
else if (command === "review") await import("./review-cli");
else if (command === "plan" || command === "apply") await import("./write-cli");
else throw new Error(`Unknown command: ${command}`);

function option(name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function positional(values: string[]): string[] {
  const result: string[] = [];
  const valueFlags = new Set([
    "--config",
    "--database",
    "--out",
    "--output-dir",
    "--country",
    "--locale",
    "--bandcamp-user",
    "--from",
  ]);
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as string;
    if (value.startsWith("--")) {
      if (valueFlags.has(value)) i++;
      continue;
    }
    result.push(value);
  }
  return result;
}

async function promptForConfig(initial: ReturnType<typeof defaultConfig>) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "--interactive requires a terminal. Use init flags for CI/headless setup.",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ask = async (label: string, fallback: string) =>
      (await prompt.question(`${label} [${fallback}]: `)).trim() || fallback;
    const database = await ask("SQLite database", initial.storage.database);
    const outputDir = await ask("Output directory", initial.storage.output_dir);
    const country = (
      await ask("TIDAL country code", initial.providers.tidal.country_code)
    ).toUpperCase();
    const locale = await ask("TIDAL locale", initial.providers.tidal.locale);
    const username = await ask(
      "Bandcamp username",
      initial.providers.bandcamp.username,
    );
    return validateConfig({
      ...initial,
      storage: { database, output_dir: outputDir },
      providers: {
        ...initial.providers,
        bandcamp: { ...initial.providers.bandcamp, username },
        tidal: { ...initial.providers.tidal, country_code: country, locale },
      },
    });
  } finally {
    prompt.close();
  }
}

function readState(databasePath: string): Record<string, number> {
  try {
    const db = new Database(databasePath, { readonly: true });
    const value = new SyncStore(db).summary();
    db.close();
    return value;
  } catch (error) {
    throw new Error(`Database is not a valid SQLite file: ${databasePath}`, {
      cause: error,
    });
  }
}

interface WishlistStateRow {
  source_item_id: number;
  source_fingerprint: string;
  removed_at: string | null;
}

function readWishlistState(
  databasePath: string,
): Map<number, WishlistStateRow> {
  if (!existsSync(databasePath)) return new Map();
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT source_item_id, source_fingerprint, removed_at FROM bandcamp_items",
      )
      .all() as WishlistStateRow[];
    return new Map(rows.map((row) => [row.source_item_id, row]));
  } finally {
    db.close();
  }
}

function summarizeRefresh(
  before: Map<number, WishlistStateRow>,
  databasePath: string,
): {
  discovered: number;
  changed: number;
  removed: number;
  new_matched: number;
  new_needs_review: number;
  new_not_found: number;
} {
  const after = readWishlistState(databasePath);
  const newIds: number[] = [];
  let discovered = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, current] of after) {
    const previous = before.get(id);
    if (!previous) {
      if (!current.removed_at) {
        discovered++;
        changed++;
        newIds.push(id);
      }
      continue;
    }
    if (
      !current.removed_at &&
      (current.source_fingerprint !== previous.source_fingerprint ||
        previous.removed_at !== null)
    ) {
      changed++;
      if (previous.removed_at !== null) newIds.push(id);
    }
    if (!previous.removed_at && current.removed_at) removed++;
  }

  const decisions = new Map<number, string>();
  if (newIds.length && existsSync(databasePath)) {
    const db = new Database(databasePath, { readonly: true });
    try {
      const rows = db
        .query(
          "SELECT bandcamp_item_id, status FROM match_decisions WHERE bandcamp_item_id IN (" +
            newIds.map(() => "?").join(",") +
            ")",
        )
        .all(...newIds) as Array<{ bandcamp_item_id: number; status: string }>;
      for (const row of rows) decisions.set(row.bandcamp_item_id, row.status);
    } finally {
      db.close();
    }
  }
  const statuses = newIds.map((id) => decisions.get(id));
  return {
    discovered,
    changed,
    removed,
    new_matched: statuses.filter(
      (status) =>
        status === "high_confidence" || status === "medium_confidence",
    ).length,
    new_needs_review: statuses.filter(
      (status) =>
        status !== undefined &&
        status !== "high_confidence" &&
        status !== "medium_confidence" &&
        status !== "not_found",
    ).length,
    new_not_found: statuses.filter((status) => status === "not_found").length,
  };
}

function resolveTokenPath(config: ReturnType<typeof loadConfig>): string {
  if (process.env.TIDAL_TOKEN_PATH) return process.env.TIDAL_TOKEN_PATH;
  const configured = join(config.storage.output_dir, "tidal-tokens.json");
  const legacy = join("./output", "tidal-tokens.json");
  return !requestedConfig && !existsSync(configured) && existsSync(legacy)
    ? legacy
    : configured;
}
