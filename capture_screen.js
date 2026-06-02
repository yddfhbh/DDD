const screenshot = require("screenshot-desktop");

async function main() {
  const displays = await screenshot.listDisplays().catch(() => []);
  console.log("displays:", displays);

  await screenshot({ filename: "screen.png" });
  console.log("saved: screen.png");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});