export interface TerminalOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export class Terminal {
  private progressActive = false;

  constructor(private readonly options: TerminalOptions = {}) {}

  output(value: unknown, human: string): void {
    if (this.options.json) console.log(JSON.stringify(value, null, 2));
    else if (!this.options.quiet) console.log(this.paint(human, "36"));
  }

  info(message: string): void {
    if (!this.options.quiet && !this.options.json) console.log(message);
  }

  debug(message: string): void {
    if (this.options.verbose && !this.options.quiet)
      console.error(this.paint(`[verbose] ${message}`, "2"));
  }

  progress(label: string, current: number, total?: number): void {
    if (this.options.quiet || this.options.json) return;
    const width = 20;
    const bar = total
      ? ` [${"#".repeat(Math.round((current / total) * width)).padEnd(width, ".")}] ${current}/${total}`
      : `: ${current}`;
    const message = `${label}${bar}`;
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${message}`);
      this.progressActive = true;
    } else if (
      !total ||
      current === 1 ||
      current === total ||
      current % 25 === 0
    )
      console.error(message);
  }

  startSpinner(message: string): () => void {
    if (this.options.quiet || this.options.json) return () => {};
    if (!process.stderr.isTTY) {
      console.error(message);
      return () => {};
    }
    const frames = ["-", "\\", "|", "/"];
    let index = 0;
    const timer = setInterval(() => {
      process.stderr.write(`\r${frames[index++ % frames.length]} ${message}`);
      this.progressActive = true;
    }, 100);
    return () => {
      clearInterval(timer);
      this.endProgress();
    };
  }

  endProgress(): void {
    if (this.progressActive) process.stderr.write("\n");
    this.progressActive = false;
  }

  private paint(value: string, code: string): string {
    return this.options.color === false
      ? value
      : `\u001b[${code}m${value}\u001b[0m`;
  }
}
