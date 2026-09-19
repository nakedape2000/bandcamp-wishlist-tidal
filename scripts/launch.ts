import { diagnoseLaunch } from "../src/launcher";
import { browserCommand } from "../src/oauth";

const args = process.argv.slice(2);
const host = option("--host") ?? "127.0.0.1";
const port = Number(option("--port") ?? process.env.BCTS_REVIEW_PORT ?? 4173);
const requestedConfig = option("--config");
const docker = args.includes("--docker");
const diagnostics = await diagnoseLaunch({
  host,
  port,
  configPath: requestedConfig,
  docker,
});

for (const check of diagnostics.checks)
  console.log(`${check.ok ? "PASS" : "WARN"} ${check.name}: ${check.detail}`);
console.log(`Data directory: ${diagnostics.dataDirectory}`);

if (!diagnostics.ready) {
  process.exitCode = 1;
} else if (args.includes("--check") || docker) {
  if (docker)
    console.log("Docker is ready. Start it with: docker compose up --build");
} else {
  if (args.includes("--open")) {
    const command = browserCommand(diagnostics.address);
    if (command)
      Bun.spawn([command.command, ...command.args], {
        stdout: "ignore",
        stderr: "ignore",
      });
    else console.log(`Open this address in a browser: ${diagnostics.address}`);
  }
  await import("./review-server");
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
