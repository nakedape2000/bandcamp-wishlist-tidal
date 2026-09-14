import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { WishlistSnapshot } from "./types";

export async function writeSnapshot(
  snapshot: WishlistSnapshot,
  path: string,
  pretty: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(snapshot, null, pretty ? 2 : 0));
  await chmod(path, 0o600);
}
