const { chromium } = require("playwright");
const readline = require("node:readline");

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

async function tap(page, key, delay = 80) {
  console.log("press:", key);
  await page.keyboard.press(key);
  await page.waitForTimeout(delay);
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto("https://tetr.io/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("브라우저에서 직접 로그인하고, 커스텀/솔로 아무 게임 화면까지 들어가.");
  console.log("첫 미노가 움직일 수 있는 상태에서 PowerShell에 Enter.");

  await waitForEnter("준비되면 Enter: ");

  await page.bringToFront();

  // 테스트 입력: 오른쪽 2번, 회전 1번, 하드드랍
  await tap(page, "ArrowRight");
  await tap(page, "ArrowRight");
  await tap(page, "ArrowUp");
  await tap(page, "Space", 150);

  console.log("키 입력 테스트 완료.");
  console.log("브라우저는 그대로 둠. 종료하려면 PowerShell에서 Ctrl+C 또는 브라우저 닫기.");

  await waitForEnter("종료하려면 Enter: ");
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});