import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { URL } from "node:url";
import { writeFileSync } from "node:fs";

const clientId = process.env.TIDAL_CLIENT_ID;
const redirectUri = process.env.TIDAL_REDIRECT_URI ?? "http://localhost:8765/callback";
const scopes = process.env.TIDAL_SCOPES ?? "collection.read";

if (!clientId) {
  throw new Error("Missing TIDAL_CLIENT_ID in .env");
}

const redirect = new URL(redirectUri);
const port = Number(redirect.port || 80);
const callbackPath = redirect.pathname;

const base64Url = (buffer: Buffer) =>
  buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const verifier = base64Url(randomBytes(32));
const challenge = base64Url(
  createHash("sha256").update(verifier).digest()
);
const state = base64Url(randomBytes(24));

const authorizeUrl = new URL("https://login.tidal.com/authorize");
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: scopes,
  code_challenge_method: "S256",
  code_challenge: challenge,
  state,
}).toString();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://127.0.0.1:${port}`
  );

  if (requestUrl.pathname !== callbackPath) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const returnedState = requestUrl.searchParams.get("state");
  const error = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");

  if (returnedState !== state) {
    response.writeHead(400);
    response.end("Invalid OAuth state.");
    server.close();
    process.exit(1);
  }

  if (error || !code) {
    response.writeHead(400);
    response.end(`TIDAL authorization failed: ${error ?? "missing code"}`);
    server.close();
    process.exit(1);
  }

  const tokenResponse = await fetch("https://auth.tidal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  const tokenText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    response.writeHead(500);
    response.end("Token exchange failed. Check the terminal.");
    console.error(tokenText);
    server.close();
    process.exit(1);
  }

  writeFileSync("./output/tidal-tokens.json", tokenText, "utf8");

  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("TIDAL authorization succeeded. You can close this browser tab.");
  server.close();

  console.log("Saved TIDAL tokens ? ./output/tidal-tokens.json");
});

server.listen(port, "127.0.0.1", async () => {
  console.log(`Waiting for TIDAL callback on ${redirectUri}`);
  console.log("Opening the authorization page ");

console.log("\nOpen this URL manually in your browser:\n");
console.log(authorizeUrl.toString());
console.log("\nWaiting for the TIDAL callback...\n");
});
