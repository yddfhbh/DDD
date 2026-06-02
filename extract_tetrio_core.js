const fs = require("node:fs");
const path = require("node:path");

const scriptsDir = path.join(__dirname, "tetrio-scripts");
const outPath = path.join(__dirname, "tetrio-core-snippets.txt");

const files = fs.readdirSync(scriptsDir)
  .filter(name =>
    name.includes("tetr.io_js_tetrio.js") ||
    name.includes("blob_https_tetr.io")
  );

const keywords = [
  "static BagList",
  "BagList",
  "bagtype",
  "setoptions.bagtype",
  ".bagtype",
  "seed_random",
  ".seed",
  "nextcount",
  "queue",
  "hold",
  "pieces",
  "7-bag",
];

function contextAround(text, idx, radius = 3500) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end);
}

let output = "";

for (const file of files) {
  const filePath = path.join(scriptsDir, file);
  const text = fs.readFileSync(filePath, "utf8");
  const lower = text.toLowerCase();

  output += `\n\n############################################################\n`;
  output += `FILE: ${file}\n`;
  output += `SIZE: ${text.length}\n`;
  output += `############################################################\n`;

  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    let idx = lower.indexOf(needle);
    let count = 0;

    while (idx !== -1 && count < 12) {
      output += "\n============================================================\n";
      output += `KEYWORD: ${keyword}\n`;
      output += `INDEX: ${idx}\n\n`;
      output += contextAround(text, idx);
      output += "\n";

      idx = lower.indexOf(needle, idx + needle.length);
      count++;
    }
  }
}

fs.writeFileSync(outPath, output, "utf8");
console.log("saved:", outPath);
