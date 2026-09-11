import { readFileSync } from "node:fs";

const tokenData = JSON.parse(
  readFileSync("./output/tidal-tokens.json", "utf8")
);

const accessToken = tokenData.access_token;

if (!accessToken) {
  throw new Error("No access_token found in output/tidal-tokens.json");
}

const url = new URL("https://openapi.tidal.com/v2/albums");
url.searchParams.set("countryCode", "DE");
url.searchParams.set("filter[id]", "59727856");
url.searchParams.set("include", "artists,items");

const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.api+json",
  },
});

console.log(`Status: ${response.status}`);
console.log((await response.text()).slice(0, 3000));
