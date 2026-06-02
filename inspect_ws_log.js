const fs = require("node:fs");
const { unpack } = require("msgpackr");

const inputPath = "./ws-log.jsonl";

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

function looksUseful(value) {
  let text = "";
  try {
    text = JSON.stringify(value).toLowerCase();
  } catch {
    return false;
  }

  return [
    "board",
    "queue",
    "hold",
    "piece",
    "game",
    "frame",
    "replay",
    "room",
    "players",
    "options",
    "constants",
    "seed",
    "bag",
    "display_next",
    "display_hold",
    "ige",
    "targets",
    "garbage",
    "keydown",
    "handling"
  ].some(k => text.includes(k));
}

function tryOffsets(buf) {
  const hits = [];

  for (let offset = 0; offset <= Math.min(160, buf.length - 1); offset++) {
    try {
      const decoded = unpack(buf.subarray(offset));
      if (looksUseful(decoded)) {
        hits.push({ offset, decoded: redactDeep(decoded) });
      }
    } catch {}
  }

  return hits;
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

console.log("largest binary frames:", rows.slice(0, 20).map(r => ({
  time: r.time,
  type: r.type,
  byteLength: r.byteLength,
})));

for (const row of rows.slice(0, 20)) {
  console.log("\n==============================");
  console.log("time:", row.time);
  console.log("type:", row.type);
  console.log("bytes:", row.byteLength);
  console.log("hex head:", row.hex.slice(0, 200));

  const hits = tryOffsets(row.buf);

  if (hits.length === 0) {
    console.log("no useful msgpack hit");
    continue;
  }

  for (const hit of hits.slice(0, 5)) {
    console.log("\n--- decoded hit offset:", hit.offset);
    console.dir(hit.decoded, { depth: 6 });
  }
}