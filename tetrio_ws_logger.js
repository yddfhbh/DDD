const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const logPath = path.join(__dirname, "ws-log.jsonl");
const interestingPath = path.join(__dirname, "ws-interesting.jsonl");

function now() {
  return new Date().toISOString();
}

function redact(text) {
  if (typeof text !== "string") return text;

  return text
    .replace(/(["']?(?:token|session|auth|authorization|cookie|jwt)["']?\s*[:=]\s*["']?)[^"',&\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|session|auth|authorization|cookie|jwt)=)[^&]+/gi, "$1[REDACTED]");
}

function safeUrl(urlText) {
  try {
    const u = new URL(urlText);
    for (const key of u.searchParams.keys()) {
      if (/token|session|auth|cookie|jwt/i.test(key)) {
        u.searchParams.set(key, "[REDACTED]");
      }
    }
    return u.toString();
  } catch {
    return redact(urlText);
  }
}

function payloadToText(payload) {
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    const buf = Buffer.from(payload);
    return `[binary ${buf.length} bytes] ${buf.toString("hex")}`;
  }

  if (typeof payload === "string") {
    return redact(payload);
  }

  return redact(String(payload));
}

function writeJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function looksInteresting(text) {
  const lower = text.toLowerCase();

  return [
    "board",
    "queue",
    "hold",
    "piece",
    "game",
    "room",
    "replay",
    "frame",
    "targets",
    "garbage",
    "pps",
    "apm",
    "vs",
    "ige",
    "start",
    "end",
    "keydown",
    "keyup",
    "move",
    "players",
    "options",
    "seed",
    "display_next",
    "display_hold",
  ].some(k => lower.includes(k));
}

async function main() {
  console.log("로그 저장:", logPath);
  console.log("중요 후보 저장:", interestingPath);

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({
    viewport: null,
  });

  const page = await context.newPage();

  page.on("console", msg => {
    const text = msg.text();
    if (/error|warn/i.test(text)) {
      console.log("[browser console]", text.slice(0, 300));
    }
  });

  page.on("websocket", ws => {
    const url = safeUrl(ws.url());
    console.log("[WS OPEN]", url);

    writeJsonl(logPath, {
      time: now(),
      type: "ws_open",
      url,
    });

    ws.on("framesent", event => {
      const text = payloadToText(event.payload);

      const obj = {
        time: now(),
        type: "sent",
        url,
        length: text.length,
        payload: text,
      };

      writeJsonl(logPath, obj);

      if (looksInteresting(text)) {
        console.log("[WS SENT interesting]", text.slice(0, 300));
        writeJsonl(interestingPath, obj);
      }
    });

    ws.on("framereceived", event => {
      const text = payloadToText(event.payload);

      const obj = {
        time: now(),
        type: "received",
        url,
        length: text.length,
        payload: text,
      };

      writeJsonl(logPath, obj);

      if (looksInteresting(text)) {
        console.log("[WS RECV interesting]", text.slice(0, 300));
        writeJsonl(interestingPath, obj);
      }
    });

    ws.on("close", () => {
      console.log("[WS CLOSE]", url);
      writeJsonl(logPath, {
        time: now(),
        type: "ws_close",
        url,
      });
    });
  });

  await page.goto("https://tetr.io/", {
    waitUntil: "domcontentloaded",
  });

  setInterval(async () => {
  try {
    const result = await page.evaluate(() => {
      function typeOf(value) {
        if (value === null) return "null";
        if (Array.isArray(value)) return "array";
        return typeof value;
      }

      function preview(value) {
        const t = typeOf(value);

        if (t === "string") return value.slice(0, 80);
        if (t === "number" || t === "boolean" || t === "null") return value;

        if (t === "array") {
          return {
            length: value.length,
            sample: value.slice(0, 5).map(v => typeOf(v)),
          };
        }

        if (t === "object") {
          let keys = [];
          try {
            keys = Object.keys(value).slice(0, 30);
          } catch {}
          return { keys };
        }

        if (t === "function") return "function";

        return t;
      }

      function scan(root, rootName) {
        const hits = [];
        const seen = new WeakSet();

        const keyRegex = /board|field|matrix|queue|next|hold|piece|current|active|game|room|player|players|engine|state|replay|seed|bag|frame|handling/i;

        function walk(value, path, depth) {
          if (hits.length >= 200) return;
          if (depth > 5) return;

          const t = typeOf(value);

          if (t === "object" || t === "array" || t === "function") {
            if (value && seen.has(value)) return;
            if (value) seen.add(value);
          }

          const lastKey = path.split(".").pop() || "";

          if (keyRegex.test(lastKey)) {
            hits.push({
              path,
              type: t,
              preview: preview(value),
            });
          }

          if (t !== "object" && t !== "array") return;

          let keys = [];
          try {
            keys = Object.keys(value);
          } catch {
            return;
          }

          for (const key of keys.slice(0, 80)) {
            // 너무 위험하거나 쓸모없는 쪽은 스킵
            if (/token|auth|cookie|session|jwt/i.test(key)) continue;

            let child;
            try {
              child = value[key];
            } catch {
              continue;
            }

            walk(child, `${path}.${key}`, depth + 1);
          }
        }

        walk(root, rootName, 0);
        return hits;
      }

      return {
        windowKeys: Object.keys(window)
          .filter(k =>
            /game|room|tetr|ribbon|client|state|app|vue|pixi|engine|replay|gamera/i.test(k)
          )
          .slice(0, 100),

        gameraType: typeof window.gamera,
        gameraKeys: window.gamera ? Object.keys(window.gamera).slice(0, 100) : [],
        gameraHits: window.gamera ? scan(window.gamera, "gamera") : [],
      };
    });

    console.log("[probe window keys]", result.windowKeys);
    console.log("[probe gamera type]", result.gameraType);
    console.log("[probe gamera keys]", result.gameraKeys);

    console.log("[probe gamera hits]");
    for (const hit of result.gameraHits.slice(0, 80)) {
      console.log(JSON.stringify(hit));
    }
  } catch (err) {
    console.log("[probe error]", err.message);
  }
}, 5000);

  console.log("");
  console.log("브라우저가 열리면 직접 로그인하고 커스텀 방에 들어가.");
  console.log("5초마다 [window keys]가 뜨는지 확인.");
  console.log("종료하려면 이 PowerShell에서 Ctrl+C.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});