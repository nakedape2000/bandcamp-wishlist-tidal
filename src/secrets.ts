import { chmod, readFile } from "node:fs/promises";

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  expires_at?: string;
}

export async function readTokenFile(path: string): Promise<TokenData> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<TokenData>;
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0)
    throw new Error(`No access_token found in ${path}`);
  await chmod(path, 0o600);
  return raw as TokenData;
}
