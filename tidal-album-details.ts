import { readFileSync } from "node:fs";

const tokenData = JSON.parse(
  readFileSync("./output/tidal-tokens.json", "utf8")
);

const accessToken = tokenData.access_token;

const headers = {
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/vnd.api+json",
};

const albumId = "527114775";

const url = new URL(
  `https://openapi.tidal.com/v2/albums/${albumId}/relationships/artists`
);

url.searchParams.set("countryCode", "DE");
url.searchParams.set("include", "artists");

const response = await fetch(url, { headers });
const text = await response.text();

console.log(`Status: ${response.status}`);
console.log(text.slice(0, 5000));
