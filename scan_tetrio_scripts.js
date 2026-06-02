const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const outPath = path.join(__dirname, "script-keyword-hits.txt");

const keywords = [
  "seed_random",
  "bagtype",
  "7-bag",
  "nextcount",
  "display_next",
  "display_hold",
  "queue",
  "hold",
  "piece",
  "board",
  "rng",
  "random",
  "Math.random",
  "seed",
  "replay",
  "keydown",
  "keyup",
];

function contextAround(text, index, radius = 700) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end);
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

async function main() {
  fs.writeFileSync(outPath, "", "utf8");

  const browser = await launchBrowser();

  const context = await browser.newContext({
    viewport: null,
  });

  const page = await context.newPage();

  const seenResources = new Set();

  page.on("response", response => {
    const url = response.url();
    if (
      url.includes(".js") ||
      url.includes("/js/") ||
      url.includes("tetr.io")
    ) {
      seenResources.add(url);
    }
  });

  console.log("TETR.IO 여는 중...");

  try {
    await page.goto("https://tetr.io/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch (err) {
    console.log("goto 경고:", err.message);
  }

  // 앱 리소스 로딩 기다리기
  await page.waitForTimeout(15000);

  console.log("JS 리소스 수집 중...");

  const scriptUrlsFromPage = await page.evaluate(() => {
    const urls = [];

    for (const s of document.scripts) {
      if (s.src) urls.push(s.src);
    }

    for (const e of performance.getEntriesByType("resource")) {
      if (
        e.name.includes(".js") ||
        e.name.includes("/js/") ||
        e.name.includes("tetr.io")
      ) {
        urls.push(e.name);
      }
    }

    return urls;
  }).catch(() => []);

  const uniqueUrls = [...new Set([...seenResources, ...scriptUrlsFromPage])]
    .filter(url =>
      url.includes(".js") ||
      url.includes("/js/") ||
      url.includes("tetr.io")
    );

  console.log("JS/resource 후보:", uniqueUrls.length);

  for (const url of uniqueUrls) {
    try {
      const res = await context.request.get(url, {
        timeout: 30000,
      });

      if (!res.ok()) continue;

      const text = await res.text();
      const lower = text.toLowerCase();

      let sections = [];

      for (const keyword of keywords) {
        const needle = keyword.toLowerCase();
        let idx = lower.indexOf(needle);
        let count = 0;

        while (idx !== -1 && count < 8) {
          sections.push(
            [
              "------------------------------------------------------------",
              `URL: ${url}`,
              `KEYWORD: ${keyword}`,
              `INDEX: ${idx}`,
              "",
              contextAround(text, idx),
              "",
            ].join("\n")
          );

          idx = lower.indexOf(needle, idx + needle.length);
          count++;
        }
      }

      if (sections.length > 0) {
        fs.appendFileSync(outPath, sections.join("\n"), "utf8");
        console.log("hit:", url, "sections:", sections.length);
      }
    } catch (err) {
      // 외부 스크립트나 광고 스크립트는 실패해도 무시
    }
  }

  console.log("완료:", outPath);
  console.log("VS Code에서 script-keyword-hits.txt 열어서 seed_random, bagtype, 7-bag 검색해봐.");

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});