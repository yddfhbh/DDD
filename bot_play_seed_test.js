const { chromium } = require("playwright");
const readline = require("node:readline");
const { getCurrentAndNext } = require("./tetrio_queue");

const seed = process.argv[2] ?? "1234019309";
const turns = Number(process.argv[3] ?? 5);

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

const SPAWN_X = 4;

let board = Array.from({ length: 20 }, () => "..........").join("|");
let hold = "";

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

async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: false,
      channel: "chrome",
      args: ["--start-maximized"],
    });
  } catch {
    return await chromium.launch({
      headless: false,
      args: ["--start-maximized"],
    });
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
    }),
  });

  if (!res.ok) {
    throw new Error(`engine_server error: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

async function tap(page, key, delay = 90) {
  await page.keyboard.press(key);
  await page.waitForTimeout(delay);
}

// SDF 무한용: Down을 길게 누르지 말고 짧게 눌러서 바닥까지 즉시 내림
async function sonicDrop(page) {
  console.log("  input: sonic soft drop");
  await page.keyboard.press(KEYS.softDrop);
  await page.waitForTimeout(180);
}

async function rotateTo(page, rotation) {
  if (rotation === "East") {
    console.log("  input: rotate cw");
    await tap(page, KEYS.rotateCW, 90);
  } else if (rotation === "South") {
    console.log("  input: rotate 180");
    await tap(page, KEYS.rotate180, 90);
  } else if (rotation === "West") {
    console.log("  input: rotate ccw");
    await tap(page, KEYS.rotateCCW, 90);
  }
}

async function moveToX(page, x) {
  const dx = x - SPAWN_X;

  if (dx < 0) {
    for (let i = 0; i < Math.abs(dx); i++) {
      console.log("  input: left");
      await tap(page, KEYS.left, 65);
    }
  } else if (dx > 0) {
    for (let i = 0; i < dx; i++) {
      console.log("  input: right");
      await tap(page, KEYS.right, 65);
    }
  }
}

// final rotation이 North인 스핀은 그냥 바닥에 내려도 회전 입력이 안 들어감.
// 그래서 일부러 East로 먼저 돌린 뒤, 바닥에서 CCW로 North로 돌려서 "스핀 입력"을 만듦.
async function prepareSpinRotation(page, finalRotation) {
  if (finalRotation === "North") {
    console.log("  input: pre-rotate cw for north spin");
    await tap(page, KEYS.rotateCW, 90);
  }
}

async function finishSpinRotation(page, finalRotation) {
  if (finalRotation === "North") {
    console.log("  input: spin rotate ccw to north");
    await tap(page, KEYS.rotateCCW, 90);
  } else {
    await rotateTo(page, finalRotation);
  }
}

async function performMove(page, move) {
  if (move.hold_used) {
    console.log("  input: hold");
    await tap(page, KEYS.hold, 140);
  }

  const isSpin = move.spin && move.spin !== "NoSpin";

  if (isSpin) {
    console.log(`  spin move detected: ${move.spin}`);

    // 1. x 위치 맞추기
    await moveToX(page, move.x);

    // 2. final rotation이 North면 미리 한 번 틀어둠
    await prepareSpinRotation(page, move.rotation);

    // 3. SDF 무한으로 바닥까지 즉시 내림
    await sonicDrop(page);

    // 4. 바닥에서 회전해서 스핀
    await finishSpinRotation(page, move.rotation);

    // 5. 락 확정
    console.log("  input: hard drop");
    await tap(page, KEYS.hardDrop, 180);
    return;
  }

  // 일반 배치는 기존처럼 회전 → 좌우 → 하드드랍
  await rotateTo(page, move.rotation);
  await moveToX(page, move.x);

  console.log("  input: hard drop");
  await tap(page, KEYS.hardDrop, 260);
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto("https://tetr.io/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("브라우저에서 직접 게임 화면까지 들어가.");
  console.log("중요: 실제 게임 seed/큐가 스크립트 seed와 같아야 정확히 맞음.");
  console.log(`현재 스크립트 seed=${seed}, turns=${turns}`);
  await waitForEnter("첫 미노 조작 가능한 상태에서 Enter: ");

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

    await page.waitForTimeout(180);
  }

  console.log("테스트 입력 완료.");
  console.log("브라우저 상태 확인하고, 종료하려면 PowerShell에서 Enter.");
  await waitForEnter("종료 Enter: ");
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});