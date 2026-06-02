const fs = require("node:fs");
const { getCurrentAndNext } = require("./tetrio_queue");

const seed = process.argv[2] ?? "1234019309";
const turns = Number(process.argv[3] ?? 20);
const optionsSource = process.argv[4] ?? process.env.TETRIO_BOT_OPTIONS_FILE ?? "";

let board = Array.from({ length: 20 }, () => "..........").join("|");
let hold = "";
let roomOptions = loadRoomOptions(optionsSource);

function walk(value, visitor) {
  if (!value || typeof value !== "object") return;

  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor);
    }
    return;
  }

  for (const child of Object.values(value)) {
    walk(child, visitor);
  }
}

function isGameOptions(value) {
  return value
    && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, "seed")
    && Object.prototype.hasOwnProperty.call(value, "bagtype");
}

function findGameOptions(value) {
  let exact = null;
  let fallback = null;

  walk(value, obj => {
    const candidates = [obj.options, obj.setoptions, obj];

    for (const candidate of candidates) {
      if (!isGameOptions(candidate)) continue;

      if (String(candidate.seed) === String(seed)) {
        exact = candidate;
        return;
      }

      fallback ??= candidate;
    }
  });

  return exact || fallback;
}

function loadRoomOptions(source) {
  if (process.env.TETRIO_BOT_OPTIONS_JSON) {
    try {
      return JSON.parse(process.env.TETRIO_BOT_OPTIONS_JSON);
    } catch (err) {
      console.warn(`failed to parse TETRIO_BOT_OPTIONS_JSON: ${err.message}`);
      return {};
    }
  }

  if (!source) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
    return findGameOptions(parsed) || {};
  } catch (err) {
    console.warn(`failed to load room options from ${source}: ${err.message}`);
    return {};
  }
}

function optionValue(value) {
  return value == null ? "-" : String(value);
}

async function getBestMove(current, queue, board, hold) {
  const res = await fetch("http://127.0.0.1:8787/best-move", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      current,
      queue,
      board,
      hold: hold || "",
      options: roomOptions,
    }),
  });

  if (!res.ok) {
    throw new Error(`engine_server error: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

async function main() {
  if (Object.keys(roomOptions).length > 0) {
    console.log(
      `room options: spinbonuses=${optionValue(roomOptions.spinbonuses)} combotable=${optionValue(roomOptions.combotable)} b2bcharging=${optionValue(roomOptions.b2bcharging)} allclear=${optionValue(roomOptions.allclear_garbage)}/${optionValue(roomOptions.allclear_b2b)} garbage=${optionValue(roomOptions.garbagemultiplier)}`
    );
    console.log("");
  }

  let pieceIndex = 0;

  for (let turn = 0; turn < turns; turn++) {
    const q = getCurrentAndNext(seed, pieceIndex, 6);
    const move = await getBestMove(q.current, q.queue, board, hold);

    if (!move.ok) {
      console.log("move failed:", move);
      break;
    }

    console.log(
      `turn=${turn} index=${pieceIndex} current=${q.current} hold=${hold || "-"} queue=${q.queue} -> piece=${move.piece} rot=${move.rotation} x=${move.x} y=${move.y} spin=${move.spin} hold_used=${move.hold_used} cleared=${move.cleared} score=${move.score}`
    );
    if (Array.isArray(move.inputs)) {
      console.log(`inputs=${move.inputs.join(" ")}`);
    }

    if (!move.next_board) {
      console.log("next_board가 없음.");
      console.log(move);
      break;
    }

    board = move.next_board;

    if (move.hold_used) {
      if (!hold) {
        // 현재 미노를 hold에 넣고, queue[0]을 사용해서 배치한 상황
        hold = q.current;
        pieceIndex += 2;
      } else {
        // hold 미노와 현재 미노를 교체해서 hold 미노를 배치한 상황
        const oldHold = hold;
        hold = q.current;
        pieceIndex += 1;

        console.log(`  hold swap: used ${oldHold}, new hold=${hold}`);
      }
    } else {
      pieceIndex += 1;
    }

    console.log(board.split("|").slice(-6).join("\n"));
    console.log("");
  }

  console.log("final hold:", hold || "-");
  console.log("final board:");
  console.log(board.split("|").join("\n"));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
