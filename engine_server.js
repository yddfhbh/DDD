const http = require("node:http");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const enginePath = path.join(__dirname, "target", "release", "quick_best.exe");
const PORT = 8787;
const SOFTDROP_MODE = process.env.TETRIO_BOT_SOFTDROP_MODE
  ?? (process.env.TETRIO_BOT_ALLOW_SOFTDROP === "1" ? "allow" : "grounded-spin");

function getBestMove({ current, queue, board, hold, options }) {
  const args = [current, queue];

  // hold를 넘기려면 board 자리도 필요함
  if (board || hold) {
    args.push(board || "");
  }

  if (hold) {
    args.push(hold);
  }

  if (SOFTDROP_MODE === "blocked" || SOFTDROP_MODE === "none") {
    args.push("--no-softdrop");
  } else if (SOFTDROP_MODE !== "allow") {
    args.push("--grounded-softdrop-spins");
  }

  if (options && typeof options === "object" && Object.keys(options).length > 0) {
    args.push("--options-json", JSON.stringify(options));
  }

  const result = spawnSync(enginePath, args, {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.stderr && result.stderr.trim()) {
    console.error("[engine stderr]", result.stderr.trim());
  }

  const stdout = result.stdout.trim();

  if (!stdout) {
    throw new Error("Engine returned empty output");
  }

  return JSON.parse(stdout);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/best-move") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
    return;
  }

  let body = "";

  req.on("data", chunk => {
    body += chunk;
  });

  req.on("end", () => {
    try {
      const input = JSON.parse(body);

      if (!input.current || !input.queue) {
        throw new Error("current and queue are required");
      }

      const move = getBestMove({
        current: String(input.current),
        queue: String(input.queue),
        board: input.board || "",
        hold: input.hold || "",
        options: input.options || null,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(move));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: err.message,
      }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`fusion engine server running on http://127.0.0.1:${PORT}`);
  console.log(`softdrop input: ${SOFTDROP_MODE}`);
  console.log(`ai profile: ${process.env.TETRIO_BOT_AI_PROFILE || "stable"}`);
});
