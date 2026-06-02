const fs = require("node:fs");
const { unpack } = require("msgpackr");

const inputPath = "./ws-log.jsonl";

function extractHex(payload) {
  if (typeof payload !== "string") return null;
  const match = payload.match(/^\[binary\s+\d+\s+bytes\]\s+([0-9a-f]+)$/i);
  return match ? match[1] : null;
}

function tryUnpackOffsets(buf) {
  const offsets = [5, 24, 25, 0];
  for (const offset of offsets) {
    if (offset >= buf.length) continue;
    try {
      return { offset, value: unpack(buf.subarray(offset)) };
    } catch {}
  }
  return null;
}

function keysOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  return Object.keys(v).join(",");
}

function summarizeValue(v) {
  if (Array.isArray(v)) {
    return `array len=${v.length}`;
  }

  if (!v || typeof v !== "object") {
    return String(v).slice(0, 120);
  }

  if (v.iges && Array.isArray(v.iges)) {
    const types = v.iges.map(e => {
      const dataKeys = e.data && typeof e.data === "object"
        ? Object.keys(e.data).join("/")
        : "";
      return `${e.type}@${e.frame}${dataKeys ? `(${dataKeys})` : ""}`;
    }).join(", ");

    return `gameid=${v.gameid} iges=[${types}]`;
  }

  if (v.data && typeof v.data === "object") {
    return `gameid=${v.gameid ?? ""} dataKeys=${Object.keys(v.data).join(",")}`;
  }

  return `keys=${keysOf(v)}`;
}

const lines = fs.readFileSync(inputPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean);

const rows = [];

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
  const decoded = tryUnpackOffsets(buf);

  if (!decoded) continue;

  const v = decoded.value;

  // token, signature 같은 로그인 패킷은 요약에서 제외
  const text = JSON.stringify(v).toLowerCase();
  if (text.includes("token") || text.includes("signature")) {
    continue;
  }

  rows.push({
    time: row.time,
    dir: row.type,
    bytes: buf.length,
    offset: decoded.offset,
    summary: summarizeValue(v),
    keys: keysOf(v),
  });
}

for (const r of rows) {
  console.log(`${r.time} ${r.dir.padEnd(8)} bytes=${String(r.bytes).padStart(5)} off=${String(r.offset).padStart(2)} ${r.summary}`);
  if (r.keys) {
    console.log(`  keys: ${r.keys}`);
  }
}