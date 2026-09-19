import { tmpdir } from "node:os";

run([process.execPath, "test"]);
run([process.execPath, "x", "--bun", "tsc", "--noEmit"]);
run([
  process.execPath,
  "x",
  "biome",
  "check",
  "src/platform.ts",
  "src/launcher.ts",
  "src/config.ts",
  "src/providers",
  "scripts/launch.ts",
  "scripts/main.ts",
  "scripts/modern-cli.ts",
  "scripts/scan-bandcamp.ts",
  "scripts/write-cli.ts",
  "test/m8.test.ts",
  "test/m9.test.ts",
]);
run(["git", "diff", "--check"]);

function run(command: string[]): void {
  const result = Bun.spawnSync(command, {
    env: {
      ...process.env,
      TMPDIR: tmpdir(),
      BUN_INSTALL_CACHE_DIR:
        process.env.BUN_INSTALL_CACHE_DIR ?? `${tmpdir()}/bun-install-cache`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
