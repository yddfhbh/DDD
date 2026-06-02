const { spawnSync } = require("node:child_process");
const path = require("node:path");

const enginePath = path.join(__dirname, "target", "release", "quick_best.exe");

function getBestMove(currentPiece, queue, board = "") {
  const args = board
    ? [currentPiece, queue, board]
    : [currentPiece, queue];

  const result = spawnSync(enginePath, args, {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stderr) {
    console.error("[engine stderr]", stderr);
  }

  if (!stdout) {
    throw new Error("Engine returned empty output");
  }

  const parsed = JSON.parse(stdout);

  if (!parsed.ok) {
    throw new Error(`Engine failed: ${parsed.error || "unknown error"}`);
  }

  return parsed;
}

const board = "..........|..........|....XX....|...XXXX...";
const move = getBestMove("T", "IOLJSZ", board);

console.log("추천 수:", move);
console.log(`piece=${move.piece}, rotation=${move.rotation}, x=${move.x}, y=${move.y}`);