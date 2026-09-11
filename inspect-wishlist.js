const fs = require("fs");

const file = "./output/wishlist.json";
const data = JSON.parse(fs.readFileSync(file, "utf8"));

console.log("Top-level type:", Array.isArray(data) ? "array" : typeof data);

if (Array.isArray(data)) {
  console.log("Items:", data.length);
  console.dir(data[0], { depth: null });
} else {
  console.log("Top-level keys:", Object.keys(data));
  console.dir(data, { depth: 2 });
}
