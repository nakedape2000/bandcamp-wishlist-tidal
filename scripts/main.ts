#!/usr/bin/env bun

const cliArgs = process.argv.slice(2);
const configArgument = argumentValue(cliArgs, "--config");
const databaseArgument = argumentValue(cliArgs, "--database");
if (configArgument) process.env.BCTS_CONFIG = configArgument;
if (databaseArgument) process.env.BCTS_DATABASE = databaseArgument;
const commandIndex = findCommandIndex(cliArgs);
const command = commandIndex >= 0 ? cliArgs[commandIndex] : undefined;
if (commandIndex > 0) {
  const reordered = [
    command as string,
    ...cliArgs.slice(0, commandIndex),
    ...cliArgs.slice(commandIndex + 1),
  ];
  process.argv.splice(2, cliArgs.length, ...reordered);
}
if (process.argv.includes("--quiet")) {
  console.log = () => {};
  console.table = () => {};
}
if (process.argv.includes("--no-color")) process.env.NO_COLOR = "1";
if (process.argv.includes("--verbose")) process.env.BCTS_VERBOSE = "1";
if (process.argv.includes("--json")) process.env.BCTS_LOG_JSON = "1";
if (process.env.BCTS_VERBOSE === "1" && !process.argv.includes("--quiet"))
  console.error(`[verbose] command=${command ?? "sync"}`);
if (["review", "plan", "apply"].includes(command ?? "")) {
  if (command === "review") await import("./review-cli");
  else await import("./write-cli");
} else if (
  [
    "init",
    "config",
    "status",
    "doctor",
    "help",
    "--help",
    "auth",
    "cache",
    "export",
    "completions",
    "scan",
    "matches",
    "verify",
    "logs",
    "import",
    "tutorial",
    "self-update",
  ].includes(command ?? "")
)
  await import("./modern-cli");
else await import("./sync");

export {};

function findCommandIndex(values: string[]): number {
  const withValues = new Set([
    "--config",
    "--database",
    "--out",
    "--output-dir",
    "--country",
    "--locale",
    "--bandcamp-user",
    "--from",
  ]);
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as string;
    if (withValues.has(value)) {
      index++;
      continue;
    }
    if (!value.startsWith("--")) return index;
  }
  return -1;
}

function argumentValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
