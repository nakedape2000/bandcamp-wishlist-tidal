import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { logEvent } from "../src/logger";
import { summarizeToken } from "../src/oauth";

const config = loadConfig();

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

check(
  "Bun",
  typeof Bun !== "undefined",
  typeof Bun !== "undefined" ? Bun.version : "missing",
);
try {
  const fixtureDirectory = join(import.meta.dir, "..", "fixtures");
  await access(
    join(fixtureDirectory, "tutorial-data-blob.html"),
    constants.R_OK,
  );
  await access(
    join(fixtureDirectory, "tutorial-api-response.json"),
    constants.R_OK,
  );
  check("Fixture files", true, "fixtures are readable");
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  check(
    "Fixture files",
    false,
    code === "ENOENT"
      ? "tutorial fixtures are missing"
      : "fixture files are not readable",
  );
}
try {
  const mode = (await stat(".env")).mode & 0o777;
  check(".env permissions", mode === 0o600, `mode ${mode.toString(8)}`);
} catch {
  check(".env permissions", true, "no local .env file");
}
const configuredTokenPath =
  process.env.TIDAL_TOKEN_PATH ??
  join(config.storage.output_dir, "tidal-tokens.json");
const tokenPath =
  existsSync(configuredTokenPath) || process.env.BCTS_CONFIG
    ? configuredTokenPath
    : "output/tidal-tokens.json";
if (!existsSync(tokenPath)) {
  check("Token permissions", true, "no local token file");
  check(
    "TIDAL token status",
    true,
    "not authorized (offline work is supported)",
  );
} else {
  try {
    const mode = (await stat(tokenPath)).mode & 0o777;
    check("Token permissions", mode === 0o600, `mode ${mode.toString(8)}`);
  } catch {
    check("Token permissions", false, "token file is not readable");
  }
  try {
    const status = summarizeToken(
      JSON.parse(await readFile(tokenPath, "utf8")),
    );
    check(
      "TIDAL token status",
      status.configured &&
        status.expired !== true &&
        !status.missing_scopes.length,
      !status.configured
        ? "not configured; rerun sync auth tidal"
        : status.expired
          ? "expired; rerun sync auth tidal"
          : status.missing_scopes.length
            ? `missing scopes: ${status.missing_scopes.join(", ")}; rerun sync auth tidal`
            : "usable",
    );
  } catch {
    check(
      "TIDAL token status",
      false,
      "token file is malformed; rerun sync auth tidal",
    );
  }
}
check(
  "TIDAL client configuration",
  Boolean(process.env.TIDAL_CLIENT_ID),
  process.env.TIDAL_CLIENT_ID
    ? "configured"
    : "not configured (offline work is supported)",
);
check(
  "Default config",
  config.security.dry_run_by_default,
  "dry-run by default",
);
const sourceCheckout = existsSync(join(import.meta.dir, "..", ".git"));
if (sourceCheckout) {
  try {
    check(
      "Git",
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
      }).trim() === "true",
      "repository detected",
    );
  } catch {
    check("Git", false, "source checkout is not a Git repository");
  }
} else check("Git", true, "not required for packaged installation");

for (const result of checks) {
  if (process.env.BCTS_LOG_JSON === "1") logEvent("doctor.check", result);
  else
    console.log(
      `${result.ok ? "PASS" : "WARN"} ${result.name}: ${result.detail}`,
    );
}
if (checks.some(({ name, ok }) => !ok && name !== "TIDAL client configuration"))
  process.exitCode = 1;
