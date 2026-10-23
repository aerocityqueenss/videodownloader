/**
 * shots.mjs — capture reference screenshots (landing + open companion panel).
 * Run:  node shots.mjs
 */
import { pathToFileURL } from "node:url";

const m = await import(pathToFileURL(
  process.env.PLAYWRIGHT_CORE_PATH ||
  "C:/Users/Sapna/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.js",
).href);
const chromium = m.chromium ?? m.default?.chromium;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
await page.goto(process.env.BASE_URL || "http://127.0.0.1:4173", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: ".shots/landing.png" });

await page.click("#labuboBtn");
await page.waitForSelector("#labuboPanel.is-open");
await page.waitForTimeout(1600);
await page.screenshot({ path: ".shots/companion-open.png" });

await page.locator("#labuboPanel").screenshot({ path: ".shots/panel.png" });
await page.locator("#labuboBtn").screenshot({ path: ".shots/button.png" });
// the hero mascot is always floating, so clip its region from the page instead
await page.click("#labuboClose");
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
const box = await page.locator("#heroStage").boundingBox();
await page.screenshot({ path: ".shots/mascot.png", clip: box });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: ".shots/mobile.png" });

await browser.close();
console.log("screenshots written to .shots/");
