const fs = require("node:fs");
const { unpack } = require("msgpackr");

const inputPath = "./ws-log.jsonl";

function extractHex(payload) {
  if (typeof payload !== "string") return null;

  const match = payload.match(/^\[binary\s+\d+\s+bytes\]\s+([0-9a-f]+)$/i);
  if (!match) return null;

  return match[1];
}

function redactDeep(value) {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[JWT_REDACTED]");
  }

  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|session|auth|authorization|cookie|jwt/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }

  return value;
}

function looksUseful(obj) {
  const text = JSON.stringify(obj).toLowerCase();

  return [
    "board",
    "queue",
    "hold",
    "piece",
    "game",
    "frame",
    "replay",
    "room",
    "garbage",
    "ige",
    "events",
    "players",
    "replay",
    "keys",
    "targets"
  ].some(k => text.includes(k));
}

function tryDecodeAtOffsets(buf) {
  const results = [];

  for (let offset = 0; offset <= Math.min(32, buf.length - 1); offset++) {
    try {
      const decoded = unpack(buf.subarray(offset));
      results.push({ offset, decoded });
    } catch {}
  }

  return results;
}

const lines = fs.readFileSync(inputPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean);

let found = 0;

for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }

  const hex = extractHex(row.payload);
  if (!hex) continue;

  const buf = Buffer.from(hex, "hex");
  const decodedList = tryDecodeAtOffsets(buf);

  for (const item of decodedList) {
    const safe = redactDeep(item.decoded);

    if (looksUseful(safe)) {
      found++;

      console.log("\n==============================");
      console.log("time:", row.time);
      console.log("type:", row.type);
      console.log("bytes:", buf.length);
      console.log("offset:", item.offset);
      console.dir(safe, { depth: 10 });
    }
  }
}

console.log("\nfound useful decoded frames:", found);