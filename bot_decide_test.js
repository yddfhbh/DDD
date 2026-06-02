const { getCurrentAndNext } = require("./tetrio_queue");

const seed = process.argv[2] ?? "1234019309";
const pieceIndex = Number(process.argv[3] ?? 0);

// 일단 빈 보드 20줄
const emptyBoard = Array.from({ length: 20 }, () => "..........").join("|");

async function main() {
  const q = getCurrentAndNext(seed, pieceIndex, 6);

  console.log("queue state:", q);

  const res = await fetch("http://127.0.0.1:8787/best-move", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      current: q.current,
      queue: q.queue,
      board: emptyBoard,
    }),
  });

  if (!res.ok) {
    throw new Error(`engine_server error: ${res.status} ${await res.text()}`);
  }

  const move = await res.json();

  console.log("best move:", move);
  console.log(
    `piece=${move.piece}, rotation=${move.rotation}, x=${move.x}, y=${move.y}, hold=${move.hold_used}, score=${move.score}`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});