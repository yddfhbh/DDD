const fs = require("node:fs");
const path = require("node:path");

const scriptsDir = path.join(__dirname, "tetrio-scripts");
const outPath = path.join(__dirname, "prng-only.txt");

const files = fs.readdirSync(scriptsDir)
  .filter(name =>
    name.includes("tetr.io_js_tetrio.js") ||
    name.includes("blob_https_tetr.io")
  );

let output = "";

for (const file of files) {
  const filePath = path.join(scriptsDir, file);
  const text = fs.readFileSync(filePath, "utf8");

  const keys = [
    "PRNG:function",
    "next:function(){return t=16807",
    "shuffleArray:function"
  ];

  for (const key of keys) {
    let idx = text.indexOf(key);
    while (idx !== -1) {
      const start = Math.max(0, idx - 500);
      const end = Math.min(text.length, idx + 2500);

      output += "\n============================================================\n";
      output += `FILE: ${file}\n`;
      output += `KEY: ${key}\n`;
      output += `INDEX: ${idx}\n\n`;
      output += text.slice(start, end);
      output += "\n";

      idx = text.indexOf(key, idx + key.length);
    }
  }
}

fs.writeFileSync(outPath, output, "utf8");
console.log("saved:", outPath);