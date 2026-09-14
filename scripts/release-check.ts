import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  name?: unknown;
  version?: unknown;
  bin?: Record<string, unknown>;
  engines?: { bun?: unknown };
};

if (typeof packageJson.name !== "string" || !packageJson.name)
  throw new Error("package.json name is required");
if (typeof packageJson.version !== "string" || !packageJson.version)
  throw new Error("package.json version is required");
if (typeof packageJson.bin?.["bandcamp-tidal-sync"] !== "string")
  throw new Error("package CLI bin is missing");
if (typeof packageJson.engines?.bun !== "string")
  throw new Error("package Bun engine constraint is missing");

const result = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], {
  stdout: "pipe",
  stderr: "pipe",
});
const output = new TextDecoder().decode(result.stdout);
const errors = [".env", "output/", ".sqlite"].filter((entry) =>
  new RegExp(`^packed .*${entry.replace(".", "\\.")}`, "m").test(output),
);
if (result.exitCode !== 0) throw new Error("bun pm pack --dry-run failed");
if (errors.length)
  throw new Error(`Forbidden package entries: ${errors.join(", ")}`);

console.log(
  `Release package checks passed for ${packageJson.name}@${packageJson.version}`,
);
