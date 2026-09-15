import "dotenv/config";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { URL } from "node:url";
import { browserCommand, prepareTokenDocument } from "./src/oauth";
import { Terminal } from "./src/terminal";

const clientId = process.env.TIDAL_CLIENT_ID;
const redirectUri =
  process.env.TIDAL_REDIRECT_URI ?? "http://localhost:8765/callback";
const scopes = process.env.TIDAL_SCOPES ?? "collection.read collection.write";
const tokenPath = process.env.TIDAL_TOKEN_PATH ?? "./output/tidal-tokens.json";
const terminal = new Terminal({
  quiet: process.argv.includes("--quiet"),
  color:
    !process.argv.includes("--no-color") &&
    !process.env.NO_COLOR &&
    process.stderr.isTTY,
});
let stopWaiting = () => {};

if (!clientId) {
  throw new Error("Missing TIDAL_CLIENT_ID in .env");
}

const redirect = new URL(redirectUri);
const port = Number(redirect.port || 80);
const callbackPath = redirect.pathname;

const base64Url = (buffer: Buffer) =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const verifier = base64Url(randomBytes(32));
const challenge = base64Url(createHash("sha256").update(verifier).digest());
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
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (requestUrl.pathname !== callbackPath) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const returnedState = requestUrl.searchParams.get("state");
  const error = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");

  if (returnedState !== state) {
    stopWaiting();
    response.writeHead(400);
    response.end("Invalid OAuth state.");
    console.error(
      "OAuth callback state did not match. Close the browser tab and rerun sync auth tidal.",
    );
    server.close();
    process.exit(1);
  }

  if (error || !code) {
    stopWaiting();
    response.writeHead(400);
    response.end(`TIDAL authorization failed: ${error ?? "missing code"}`);
    console.error(
      `TIDAL authorization failed (${error ?? "missing code"}). Rerun sync auth tidal and complete the newest browser tab.`,
    );
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
    stopWaiting();
    response.writeHead(500);
    response.end(
      "Token exchange failed. Return to the terminal for recovery steps.",
    );
    console.error(
      `Token exchange failed (HTTP ${tokenResponse.status}). Confirm TIDAL_CLIENT_ID and TIDAL_REDIRECT_URI, then rerun sync auth tidal.`,
    );
    server.close();
    process.exit(1);
  }

  const token = prepareTokenDocument(JSON.parse(tokenText));
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  chmodSync(tokenPath, 0o600);

  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(
    "TIDAL authorization succeeded. You can close this browser tab.",
  );
  server.close();
  stopWaiting();

  console.log(`Saved TIDAL tokens to ${tokenPath}`);
});

server.on("error", (error) => {
  stopWaiting();
  console.error(
    `Could not start the local OAuth callback server on ${redirectUri}: ${error.message}. Close the process using that port or set TIDAL_REDIRECT_URI to another registered localhost callback.`,
  );
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", async () => {
  console.log(`Waiting for TIDAL callback on ${redirectUri}`);
  const url = authorizeUrl.toString();
  console.log(
    "\nAuthorization URL (copy this if the browser does not open):\n",
  );
  console.log(url);
  if (!process.argv.includes("--no-open")) {
    const opener = browserCommand(url);
    if (opener) {
      const child = spawn(opener.command, opener.args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () =>
        console.log(
          "Browser could not be opened automatically; use the URL above.",
        ),
      );
      child.unref();
    }
  }
  stopWaiting = terminal.startSpinner("Waiting for the TIDAL browser callback");
});
