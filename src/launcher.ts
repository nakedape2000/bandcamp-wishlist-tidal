import { execFileSync } from "node:child_process";
import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { configPath, loadConfig } from "./config";
import { defaultApplicationPaths } from "./platform";

export interface LaunchCheck {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
}

export interface LaunchDiagnostics {
  ready: boolean;
  address: string;
  dataDirectory: string;
  configPath: string;
  checks: LaunchCheck[];
}

export interface LaunchOptions {
  configPath?: string;
  host?: string;
  port?: number;
  docker?: boolean;
}

export async function diagnoseLaunch(
  options: LaunchOptions = {},
  dependencies: {
    runtime?: () => { available: boolean; detail: string };
    canBind?: (host: string, port: number) => Promise<boolean>;
    canWrite?: (directory: string) => Promise<void>;
    dockerAvailable?: () => boolean;
  } = {},
): Promise<LaunchDiagnostics> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const selectedConfigPath = options.configPath ?? configPath();
  const fallback = defaultApplicationPaths();
  const runtime =
    dependencies.runtime ??
    (() => ({
      available: typeof Bun !== "undefined",
      detail: typeof Bun !== "undefined" ? Bun.version : "Bun is not installed",
    }));
  const runtimeStatus = runtime();
  const checks: LaunchCheck[] = [
    {
      name: "Bun runtime",
      ok: runtimeStatus.available,
      detail: runtimeStatus.detail,
      blocking: true,
    },
  ];
  let dataDirectory = fallback.dataDirectory;
  try {
    const config = loadConfig(selectedConfigPath);
    dataDirectory = dirname(config.storage.database);
    checks.push({
      name: "Configuration",
      ok: true,
      detail: `readable: ${selectedConfigPath}`,
      blocking: true,
    });
    const canWrite = dependencies.canWrite ?? ensureWritable;
    await canWrite(dataDirectory);
    await canWrite(config.storage.output_dir);
    checks.push({
      name: "Data directory",
      ok: true,
      detail: `writable: ${dataDirectory}`,
      blocking: true,
    });
  } catch (error) {
    checks.push({
      name: "Configuration or data directory",
      ok: false,
      detail: actionableError(error, selectedConfigPath),
      blocking: true,
    });
  }
  const validPort = Number.isInteger(port) && port > 0 && port < 65536;
  const available =
    validPort && (await (dependencies.canBind ?? canBind)(host, port));
  checks.push({
    name: "Dashboard port",
    ok: available,
    detail: available
      ? `available: http://${host}:${port}`
      : validPort
        ? `http://${host}:${port} is already in use; choose another --port.`
        : "Port must be an integer from 1 to 65535.",
    blocking: true,
  });
  if (options.docker) {
    const availableDocker = (dependencies.dockerAvailable ?? dockerAvailable)();
    checks.push({
      name: "Docker Compose",
      ok: availableDocker,
      detail: availableDocker
        ? "available"
        : "Docker Compose is unavailable. Install Docker Desktop or use `bandcamp-tidal-sync start`.",
      blocking: true,
    });
  }
  return {
    ready: checks.every((check) => !check.blocking || check.ok),
    address: `http://${host}:${port}`,
    dataDirectory,
    configPath: selectedConfigPath,
    checks,
  };
}

async function ensureWritable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await access(directory, constants.W_OK);
  const probe = join(directory, `.bcts-write-probe-${process.pid}`);
  await writeFile(probe, "", { mode: 0o600 });
  await rm(probe, { force: true });
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close((error) => resolve(!error)));
  });
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function actionableError(error: unknown, selectedConfigPath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Fix ${selectedConfigPath}: ${message}`;
}
