import { join } from "node:path";

export interface OperationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class M7OperationRunner {
  private process: ReturnType<typeof Bun.spawn> | null = null;

  get active(): boolean {
    return this.process !== null;
  }

  async run(
    command: string[],
    options: {
      databasePath: string;
      configPath?: string;
      input?: string;
      onOutput?: (stream: "stdout" | "stderr", text: string) => void;
    },
  ): Promise<OperationResult> {
    if (this.process) throw new Error("Another operation is already running.");
    const entry = join(import.meta.dir, "..", "scripts", "main.ts");
    const args = [process.execPath, "run", entry, ...command];
    if (options.configPath) args.push("--config", options.configPath);
    args.push("--database", options.databasePath);
    const child = Bun.spawn(args, {
      cwd: process.cwd(),
      env: { ...process.env, BCTS_DATABASE: options.databasePath },
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
    this.process = child;
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        consume(child.stdout, "stdout", options.onOutput),
        consume(child.stderr, "stderr", options.onOutput),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      this.process = null;
    }
  }

  cancel(): boolean {
    if (!this.process) return false;
    this.process.kill("SIGTERM");
    return true;
  }
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  onOutput?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    output += text;
    onOutput?.(name, text);
  }
  output += decoder.decode();
  return output;
}
