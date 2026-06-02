const fs = require("node:fs");
const path = require("node:path");

const scriptsDir = path.join(__dirname, "tetrio-scripts");
const outPath = path.join(__dirname, "keyword-snippets.txt");

const keywords = [
  "seed_random",
  "bagtype",
  "7-bag",
  "nextcount",
  "queue",
  "hold",
  "piece",
  "seed",
  "rng",
  "random",
  "Math.random",
];

function contextAround(text, idx, radius = 1800) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end);
}

let output = "";

const files = fs.readdirSync(scriptsDir)
  .filter(name => name.endsWith(".js"));

for (const file of files) {
  const filePath = path.join(scriptsDir, file);
  const text = fs.readFileSync(filePath, "utf8");
  const lower = text.toLowerCase();

  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    let idx = lower.indexOf(needle);
    let count = 0;

    while (idx !== -1 && count < 10) {
      output += "\n============================================================\n";
      output += `FILE: ${file}\n`;
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