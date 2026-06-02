const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const outDir = path.join(__dirname, "tetrio-scripts");
const indexPath = path.join(outDir, "index.txt");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(indexPath, "", "utf8");

function safeName(url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 10);
  let name = url
    .replace(/^https?:\/\//, "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 120);

  return `${hash}_${name}.js`;
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

function waitForEnter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question("TETR.IO 방/게임 화면까지 들어간 뒤 Enter를 누르면 JS 저장을 끝냅니다...\n", () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  const saved = new Set();

  page.on("response", async response => {
    try {
      const request = response.request();
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      const looksLikeScript =
        request.resourceType() === "script" ||
        contentType.includes("javascript") ||
        url.includes(".js");

      if (!looksLikeScript) return;
      if (saved.has(url)) return;
      saved.add(url);

      const text = await response.text();

      const filename = safeName(url);
      const filePath = path.join(outDir, filename);

      fs.writeFileSync(filePath, text, "utf8");
      fs.appendFileSync(indexPath, `${filename}\n${url}\n\n`, "utf8");

      console.log("[saved script]", filename, text.length);
    } catch (err) {
      // 일부 응답은 body를 못 읽을 수 있음
    }
  });

  console.log("TETR.IO 여는 중...");
  await page.goto("https://tetr.io/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(err => {
    console.log("goto 경고:", err.message);
  });

  console.log("브라우저에서 로그인하고 커스텀 방/게임 화면까지 들어가.");
  await waitForEnter();

  console.log("저장 완료:", outDir);
  console.log("인덱스:", indexPath);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});