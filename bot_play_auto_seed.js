const { chromium } = require("playwright");
const { unpack } = require("msgpackr");
const readline = require("node:readline");
const { getCurrentAndNext } = require("./tetrio_queue");
const profileDir = "C:\\tetrio-bot-profile";

const turns = Number(process.argv[2] ?? 10);
const TAP_HOLD_MS = Number(process.env.TETRIO_BOT_TAP_HOLD_MS ?? 38);
const TAP_DELAY_MS = Number(process.env.TETRIO_BOT_TAP_DELAY_MS ?? 45);
const DAS_HOLD_MS = Number(process.env.TETRIO_BOT_DAS_HOLD_MS ?? 190);
const INPUT_DELAY_MS = Number(process.env.TETRIO_BOT_INPUT_DELAY_MS ?? 35);
const FAST_TAP_HOLD_MS = Number(process.env.TETRIO_BOT_FAST_TAP_HOLD_MS ?? 14);
const FAST_INPUT_DELAY_MS = Number(process.env.TETRIO_BOT_FAST_INPUT_DELAY_MS ?? 0);
const SOFTDROP_MODE = process.env.TETRIO_BOT_SOFTDROP_MODE
  ?? (process.env.TETRIO_BOT_ALLOW_SOFTDROP === "1" ? "allow" : "grounded-spin");

const KEYS = {
  left: "ArrowLeft",
  right: "ArrowRight",
  softDrop: "ArrowDown",
  rotateCW: "ArrowUp",
  rotateCCW: "KeyZ",
  rotate180: "KeyA",
  hold: "Shift",
  hardDrop: "Space",
};

let capturedSeed = null;
let capturedOptions = null;

let board = Array.from({ length: 20 }, () => "..........").join("|");
let hold = "";

function optionValue(value) {
  return value == null ? "-" : String(value);
}

function logOptionSummary(options) {
  console.log("[AUTO] spinbonuses:", optionValue(options.spinbonuses));
  console.log("[AUTO] combotable:", optionValue(options.combotable));
  console.log("[AUTO] b2bcharging:", optionValue(options.b2bcharging));
  console.log("[AUTO] allclear:", `${optionValue(options.allclear_garbage)}/${optionValue(options.allclear_b2b)}`);
  console.log("[AUTO] garbage multiplier:", optionValue(options.garbagemultiplier));
}

function waitForEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function tryUnpackAtOffsets(buf) {
  const out = [];

  for (let offset = 0; offset <= Math.min(24, buf.length - 1); offset++) {
    try {
      const decoded = unpack(buf.subarray(offset));
      out.push(decoded);
    } catch {}
  }

  return out;
}

function split87Frame(buf) {
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

function walk(value, visitor, path = "") {
  if (!value || typeof value !== "object") return;

  visitor(value, path);

  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, visitor, `${path}[${i}]`));
    return;
  }

  for (const [k, v] of Object.entries(value)) {
    if (/token|auth|cookie|session|jwt/i.test(k)) continue;
    walk(v, visitor, path ? `${path}.${k}` : k);
  }
}

function findGameOptions(decoded) {
  let found = null;

  walk(decoded, obj => {
    if (found) return;

    if (
      obj &&
      typeof obj === "object" &&
      Object.prototype.hasOwnProperty.call(obj, "seed") &&
      Object.prototype.hasOwnProperty.call(obj, "bagtype")
    ) {
      found = obj;
    }

    if (
      obj &&
      typeof obj === "object" &&
      obj.options &&
      typeof obj.options === "object" &&
      Object.prototype.hasOwnProperty.call(obj.options, "seed") &&
      Object.prototype.hasOwnProperty.call(obj.options, "bagtype")
    ) {
      found = obj.options;
    }

    if (
      obj &&
      typeof obj === "object" &&
      obj.setoptions &&
      typeof obj.setoptions === "object" &&
      Object.prototype.hasOwnProperty.call(obj.setoptions, "seed") &&
      Object.prototype.hasOwnProperty.call(obj.setoptions, "bagtype")
    ) {
      found = obj.setoptions;
    }
  });

  return found;
}

function inspectWsPayload(payload) {
  if (capturedSeed != null) return;

  if (!(Buffer.isBuffer(payload) || payload instanceof Uint8Array)) return;

  const buf = Buffer.from(payload);

  const candidates = [];

  const chunks = split87Frame(buf);
  if (chunks.length > 0) {
    for (const chunk of chunks) {
      candidates.push(...tryUnpackAtOffsets(chunk));
    }
  }

  candidates.push(...tryUnpackAtOffsets(buf));

  for (const decoded of candidates) {
    const options = findGameOptions(decoded);

    if (!options) continue;

    const seed = options.seed;
    const bagtype = options.bagtype;

    if (seed == null || bagtype == null) continue;

    capturedSeed = String(seed);
    capturedOptions = options;

    console.log("");
    console.log("[AUTO] game options captured!");
    console.log("[AUTO] seed:", capturedSeed);
    console.log("[AUTO] bagtype:", bagtype);
    console.log("[AUTO] nextcount:", options.nextcount);
    console.log("[AUTO] board:", `${options.boardwidth}x${options.boardheight}`);
    logOptionSummary(options);
    console.log("");

    break;
  }
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
      options: capturedOptions || {},
    }),
  });

  if (!res.ok) {
    throw new Error(`engine_server error: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

async function tapWithHold(page, key, holdMs, delayMs) {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
  await page.waitForTimeout(delayMs);
}

async function tap(page, key, delay = TAP_DELAY_MS) {
  await tapWithHold(page, key, TAP_HOLD_MS, delay);
}

async function fastTap(page, key, delay = FAST_INPUT_DELAY_MS) {
  await tapWithHold(page, key, FAST_TAP_HOLD_MS, delay);
}

async function das(page, key) {
  await page.keyboard.down(key);
  await page.waitForTimeout(DAS_HOLD_MS);
  await page.keyboard.up(key);
  await page.waitForTimeout(INPUT_DELAY_MS);
}

async function executeInput(page, input) {
  if (input === "ShiftLeft") {
    console.log("  input: left");
    await tap(page, KEYS.left, INPUT_DELAY_MS);
  } else if (input === "ShiftRight") {
    console.log("  input: right");
    await tap(page, KEYS.right, INPUT_DELAY_MS);
  } else if (input === "DasLeft") {
    console.log("  input: das left");
    await das(page, KEYS.left);
  } else if (input === "DasRight") {
    console.log("  input: das right");
    await das(page, KEYS.right);
  } else if (input === "RotateCw") {
    console.log("  input: rotate cw");
    await tap(page, KEYS.rotateCW, INPUT_DELAY_MS);
  } else if (input === "RotateCcw") {
    console.log("  input: rotate ccw");
    await tap(page, KEYS.rotateCCW, INPUT_DELAY_MS);
  } else if (input === "RotateFlip") {
    console.log("  input: rotate 180");
    await tap(page, KEYS.rotate180, INPUT_DELAY_MS);
  } else if (input === "SoftDrop") {
    console.log("  input: soft drop");
    await tap(page, KEYS.softDrop, INPUT_DELAY_MS);
  } else if (input === "HardDrop") {
    console.log("  input: hard drop");
    await tap(page, KEYS.hardDrop, 120);
  } else if (input === "NoInput") {
    await page.waitForTimeout(INPUT_DELAY_MS);
  } else {
    throw new Error(`unknown engine input: ${input}`);
  }
}

function isRotationInput(input) {
  return input === "RotateCw" || input === "RotateCcw" || input === "RotateFlip";
}

function isGroundedSoftDropSpinPath(inputs, move) {
  if (!move || move.spin === "NoSpin") return false;

  const firstSoftDrop = inputs.indexOf("SoftDrop");
  if (firstSoftDrop < 0) return true;

  let sawRotationAfterSoftDrop = false;

  for (let i = firstSoftDrop + 1; i < inputs.length; i++) {
    const input = inputs[i];

    if (input === "SoftDrop" || input === "NoInput") continue;
    if (input === "HardDrop") break;
    if (isRotationInput(input)) {
      sawRotationAfterSoftDrop = true;
      continue;
    }

    return false;
  }

  return sawRotationAfterSoftDrop;
}

async function executeFastInput(page, input) {
  if (input === "ShiftLeft" || input === "DasLeft") {
    console.log("  input: left (fast)");
    await fastTap(page, KEYS.left);
  } else if (input === "ShiftRight" || input === "DasRight") {
    console.log("  input: right (fast)");
    await fastTap(page, KEYS.right);
  } else if (input === "RotateCw") {
    console.log("  input: rotate cw (fast)");
    await fastTap(page, KEYS.rotateCW);
  } else if (input === "RotateCcw") {
    console.log("  input: rotate ccw (fast)");
    await fastTap(page, KEYS.rotateCCW);
  } else if (input === "RotateFlip") {
    console.log("  input: rotate 180 (fast)");
    await fastTap(page, KEYS.rotate180);
  } else {
    await executeInput(page, input);
  }
}

async function executeGroundedSoftDropSequence(page, inputs) {
  let grounded = false;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];

    if (input === "SoftDrop") {
      if (!grounded) {
        console.log("  input: soft drop (grounded)");
        await fastTap(page, KEYS.softDrop);
        grounded = true;
      }

      while (i + 1 < inputs.length && inputs[i + 1] === "SoftDrop") {
        i++;
      }
      continue;
    }

    if (grounded && input !== "HardDrop") {
      await executeFastInput(page, input);
      continue;
    }

    await executeInput(page, input);
  }
}

async function executeInputSequence(page, move) {
  const inputs = move.inputs;
  console.log(`  finesse inputs: ${inputs.join(" ")}`);

  if (inputs.includes("SoftDrop")) {
    if (SOFTDROP_MODE === "allow") {
      for (const input of inputs) {
        await executeInput(page, input);
      }
      return;
    }

    if (SOFTDROP_MODE === "blocked" || SOFTDROP_MODE === "none") {
      throw new Error("engine returned SoftDrop input while softdrop mode is blocked. Restart engine_server or use TETRIO_BOT_SOFTDROP_MODE=grounded-spin.");
    }

    console.log(isGroundedSoftDropSpinPath(inputs, move) ? "  softdrop mode: grounded spin" : "  softdrop mode: grounded fast");
    await executeGroundedSoftDropSequence(page, inputs);
    return;
  }

  for (const input of inputs) {
    await executeInput(page, input);
  }
}

async function performMove(page, move) {
  if (move.hold_used) {
    console.log("  input: hold");
    await tap(page, KEYS.hold, 150);
  }

  if (!Array.isArray(move.inputs) || move.inputs.length === 0) {
    throw new Error("engine response has no inputs. Rebuild quick_best.exe after the pathfinder update.");
  }

  await executeInputSequence(page, move);
}

async function waitUntilSeedCaptured() {
  while (!capturedSeed) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return capturedSeed;
}

async function main() {
  console.log("engine_server가 켜져 있어야 함: http://127.0.0.1:8787");
  console.log(`자동 플레이 턴 수: ${turns}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: "chrome",
    viewport: null,
    args: ["--start-maximized"],
  });

  const page = context.pages()[0] || await context.newPage();
  page.on("websocket", ws => {
    console.log("[WS OPEN]", ws.url());

    ws.on("framereceived", event => {
      inspectWsPayload(event.payload);
    });
  });

  await page.goto("https://tetr.io/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("");
  console.log("브라우저에서 직접 로그인하고 커스텀 게임에 들어가.");
  console.log("게임 시작 패킷에서 seed를 자동으로 잡을 거야.");
  console.log("");

  const seed = await waitUntilSeedCaptured();

  console.log(`[AUTO] seed ready: ${seed}`);
  console.log("첫 미노가 조작 가능한 상태가 되면 PowerShell에서 Enter.");
  await waitForEnter("시작 Enter: ");

  await page.bringToFront();

  let pieceIndex = 0;

  for (let turn = 0; turn < turns; turn++) {
    const q = getCurrentAndNext(seed, pieceIndex, 6);
    const move = await getBestMove(q.current, q.queue, board, hold);

    if (!move.ok) {
      console.log("move failed:", move);
      break;
    }

    console.log(
      `turn=${turn} index=${pieceIndex} current=${q.current} hold=${hold || "-"} queue=${q.queue} -> piece=${move.piece} rot=${move.rotation} x=${move.x} y=${move.y} spin=${move.spin} hold_used=${move.hold_used}`
    );

    await performMove(page, move);

    if (!move.next_board) {
      console.log("next_board 없음. 중단.");
      console.log(move);
      break;
    }

    board = move.next_board;

    if (move.hold_used) {
      if (!hold) {
        hold = q.current;
        pieceIndex += 2;
      } else {
        hold = q.current;
        pieceIndex += 1;
      }
    } else {
      pieceIndex += 1;
    }

    await page.waitForTimeout(200);
  }

  console.log("");
  console.log("자동 입력 완료.");
  console.log("final hold:", hold || "-");
  console.log("종료하려면 Enter.");
  await waitForEnter("종료 Enter: ");

  await context.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
