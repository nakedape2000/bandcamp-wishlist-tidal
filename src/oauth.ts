import type { TokenData } from "./secrets";

export const REQUIRED_TIDAL_SCOPES = [
  "collection.read",
  "collection.write",
] as const;

export function prepareTokenDocument(
  value: unknown,
  now = Date.now(),
): TokenData {
  if (!value || typeof value !== "object")
    throw new Error("TIDAL returned an invalid token response.");
  const token = value as TokenData;
  if (!token.access_token)
    throw new Error("TIDAL token response has no access_token.");
  return {
    ...token,
    expires_at:
      token.expires_at ??
      (token.expires_in
        ? new Date(now + token.expires_in * 1000).toISOString()
        : undefined),
  };
}

export function summarizeToken(token: Partial<TokenData>, now = Date.now()) {
  const scopes = new Set((token.scope ?? "").split(/\s+/).filter(Boolean));
  const missingScopes = REQUIRED_TIDAL_SCOPES.filter(
    (scope) => !scopes.has(scope),
  );
  const expiresAt = token.expires_at ?? null;
  return {
    configured: Boolean(token.access_token),
    expires_at: expiresAt,
    expired: expiresAt ? Date.parse(expiresAt) <= now : null,
    scopes: [...scopes],
    missing_scopes: missingScopes,
  };
}

export function browserCommand(
  url: string,
  platform: string = process.platform,
): { command: string; args: string[] } | null {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32")
    return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  return null;
}
