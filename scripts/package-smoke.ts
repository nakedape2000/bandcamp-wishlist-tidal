import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const archiveArgument = process.argv[2];
if (!archiveArgument) throw new Error("Usage: package-smoke.ts <archive.tgz>");

const archive = resolve(archiveArgument);
if (!existsSync(archive))
  throw new Error(`Package archive not found: ${archive}`);

const directory = mkdtempSync(join(tmpdir(), "bcts-package-smoke-"));
try {
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({ name: "bcts-package-smoke", private: true }),
  );
  run(["bun", "add", archive], directory);

  const executable = join(
    directory,
    "node_modules",
    ".bin",
    "bandcamp-tidal-sync",
  );
  const help = run([executable, "--help", "--json"], directory);
  const commands = (JSON.parse(help) as { commands?: string[] }).commands ?? [];
  for (const command of [
    "guided",
    "dashboard",
    "start",
    "backup create/restore",
    "tutorial",
  ])
    if (!commands.includes(command))
      throw new Error(`Installed CLI help is missing the ${command} command`);

  const installedRoot = join(
    directory,
    "node_modules",
    "bandcamp-wishlist-tidal",
  );
  if (!existsSync(join(installedRoot, "web", "review", "index.html")))
    throw new Error("Installed package is missing dashboard assets");

  const smokeEnvironment = { BCTS_DATA_DIR: join(directory, "data") };
  const doctor = run(
    [executable, "doctor", "--no-color"],
    directory,
    smokeEnvironment,
  );
  if (!doctor.includes("PASS Fixture files"))
    throw new Error("Installed CLI doctor did not find tutorial fixtures");

  const tutorial = run([executable, "tutorial"], directory, smokeEnvironment);
  const result = JSON.parse(tutorial.slice(tutorial.indexOf("{"))) as {
    mode?: string;
    item_count?: number;
    provider_writes?: number;
  };
  if (
    result.mode !== "fixture-dry-run" ||
    result.item_count !== 2 ||
    result.provider_writes !== 0
  )
    throw new Error("Installed CLI tutorial returned an unexpected result");

  const launchCheck = run(
    [executable, "start", "--check", "--port", "49152"],
    directory,
    smokeEnvironment,
  );
  if (
    !launchCheck.includes("PASS Configuration") ||
    !launchCheck.includes("PASS Data directory") ||
    !launchCheck.includes("PASS Dashboard port")
  )
    throw new Error("Installed CLI start check did not pass");

  console.log(`Package smoke test passed: ${basename(archive)}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function run(
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...process.env,
      ...environment,
      TMPDIR: tmpdir(),
      BUN_INSTALL_CACHE_DIR:
        process.env.BUN_INSTALL_CACHE_DIR ??
        join(tmpdir(), "bun-install-cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed:\n${result.stderr.toString()}${stdout}`,
    );
  return stdout;
}
