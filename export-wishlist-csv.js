const fs = require("fs");

const input = "./output/wishlist.json";
const output = "./output/wishlist.csv";

const data = JSON.parse(fs.readFileSync(input, "utf8"));
const items = data.items.filter(item => item.itemType === "album");

const columns = [
  "itemId",
  "artist",
  "title",
  "url",
  "addedAt"
];

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

const rows = [
  columns.join(","),
  ...items.map(item =>
    columns.map(column => csvEscape(item[column])).join(",")
  )
];

fs.writeFileSync(output, rows.join("\r\n"), "utf8");

console.log(`Wrote ${items.length} albums ? ${output}`);
