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

function usefulText(value) {
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return "";
  }
}

function isInteresting(value) {
  const text = usefulText(value);

  return [
    "players",
    "options",
    "constants",
    "seed",
    "seed_random",
    "display_next",
    "display_hold",
    "nextcount",
    "room",
    "gameid",
    "iges",
    "gameoverreason",
    "target",
    "garbage",
    "replay",
    "events",
    "keydown",
    "keyup",
    "handling",
    "queue",
    "hold",
    "piece",
    "board",
  ].some(k => text.includes(k));
}

function tryDecode(buf) {
  const attempts = [];

  // chunk는 보통 앞 1~2바이트에 내부 헤더가 붙어있는 것 같아서 여러 offset 시도
  for (let offset = 0; offset <= Math.min(8, buf.length - 1); offset++) {
    try {
      const decoded = unpack(buf.subarray(offset));
      attempts.push({ offset, decoded });
    } catch {}
  }

  return attempts;
}

function split87Frame(buf) {
  // 관찰된 형태:
  // 87 + 3바이트 seq + [4바이트 length + chunk] 반복
  const chunks = [];

  if (buf[0] !== 0x87) return chunks;

  let pos = 4;

  while (pos + 4 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;

    if (len <= 0 || pos + len > buf.length) break;

    chunks.push(buf.subarray(pos, pos + len));
    pos += len;
  }

  return chunks;
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

    return {
      time: row.time,
      type: row.type,
      buf: Buffer.from(hex, "hex"),
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.buf.length - a.buf.length);

for (const row of rows.slice(0, 30)) {
  console.log("\n==============================");
  console.log("time:", row.time);
  console.log("type:", row.type);
  console.log("bytes:", row.buf.length);
  console.log("head:", row.buf.toString("hex").slice(0, 160));

  const chunks = split87Frame(row.buf);

  if (chunks.length === 0) {
    console.log("not 0x87 chunked frame or no chunks");
    continue;
  }

  console.log("chunks:", chunks.map(c => c.length).join(", "));

  chunks.forEach((chunk, i) => {
    console.log(`\n--- chunk #${i} bytes=${chunk.length} head=${chunk.toString("hex").slice(0, 120)}`);

    const decodedAttempts = tryDecode(chunk);
    let printed = false;

    for (const attempt of decodedAttempts) {
      const safe = redactDeep(attempt.decoded);

      if (isInteresting(safe)) {
        printed = true;
        console.log("decoded offset:", attempt.offset);
        console.dir(safe, { depth: 8 });
      }
    }

    if (!printed) {
      // 그래도 문자열 힌트는 출력
      const ascii = chunk.toString("latin1").match(/[\x20-\x7E]{4,}/g) || [];
      const hints = [...new Set(ascii)]
        .filter(s => /players|options|seed|display|next|hold|queue|piece|board|game|room|target/i.test(s))
        .slice(0, 30);

      if (hints.length > 0) {
        console.log("ascii hints:", hints);
      } else {
        console.log("no decoded interesting object");
      }
    }
  });
}