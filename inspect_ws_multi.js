const fs = require("node:fs");
const { Unpackr } = require("msgpackr");

const inputPath = "./ws-log.jsonl";

const unpackr = new Unpackr({
  sequential: true,
  moreTypes: true,
});

function extractHex(payload) {
  if (typeof payload !== "string") return null;
  const match = payload.match(/^\[binary\s+\d+\s+bytes\]\s+([0-9a-f]+)$/i);
  return match ? match[1] : null;
}

function redactDeep(value) {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[JWT_REDACTED]");
  }

  if (Array.isArray(value)) return value.map(redactDeep);

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

function containsUseful(value) {
  let text = "";
  try {
    text = JSON.stringify(value).toLowerCase();
  } catch {
    return false;
  }

  return [
    "players",
    "options",
    "constants",
    "seed",
    "seed_random",
    "display_next",
    "display_hold",
    "nextcount",
    "gameid",
    "iges",
    "frame",
    "gameoverreason",
    "queue",
    "hold",
    "piece",
    "board",
    "replay",
    "events",
    "keys",
    "handling",
    "garbage",
    "targets",
  ].some(k => text.includes(k));
}

function tryDecodeMany(buf, offset) {
  try {
    const values = unpackr.unpackMultiple(buf.subarray(offset));
    if (!Array.isArray(values)) return [];

    return values
      .filter(containsUseful)
      .map(redactDeep);
  } catch {
    return [];
  }
}

const rows = fs.readFileSync(inputPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .map(row => {
    const hex = extractHex(row.payload);
    if (!hex) return null;

    const buf = Buffer.from(hex, "hex");

    return {
      time: row.time,
      type: row.type,
      byteLength: buf.length,
      hex,
      buf,
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.byteLength - a.byteLength);

for (const row of rows.slice(0, 30)) {
  console.log("\n==============================");
  console.log("time:", row.time);
  console.log("type:", row.type);
  console.log("bytes:", row.byteLength);
  console.log("hex head:", row.hex.slice(0, 180));

  let found = false;

  for (let offset = 0; offset <= Math.min(120, row.buf.length - 1); offset++) {
    const hits = tryDecodeMany(row.buf, offset);

    if (hits.length > 0) {
      found = true;
      console.log("\n--- unpackMultiple offset:", offset, "hits:", hits.length);

      for (const hit of hits.slice(0, 5)) {
        console.dir(hit, { depth: 8 });
      }
    }
  }

  if (!found) {
    console.log("no useful multi-msgpack hit");
  }
}